// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "./access/Ownable.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";
import {MerkleProof} from "./utils/MerkleProof.sol";
import {IQuadraticFunding} from "./interfaces/IQuadraticFunding.sol";

contract QuadraticFunding is Ownable, ReentrancyGuard, IQuadraticFunding {
    struct Project {
        address owner;
        string title;
        string description;
        uint256 totalDonations;
        bool active;
        uint256 matchingAllocated;
        bool matchingClaimed;
    }

    struct Round {
        uint256 matchingPool;
        bool active;
        uint256 startTime;
        uint256 endTime;
        bool matchingDistributed;
        bytes32 allocationRoot;
    }

    mapping(uint256 => Project) internal _projects;
    mapping(uint256 => mapping(address => uint256)) internal _contributions;
    mapping(uint256 => address[]) internal _donors;
    mapping(uint256 => Round) internal _rounds;
    mapping(address => bool) internal _eligible;
    bytes32 internal _eligibilityRoot;

    uint256 internal _projectCount;
    uint256 internal _currentRound;
    uint256 internal _roundDuration;

    error ProjectNotActive();
    error ProjectDoesNotExist();
    error ZeroDonation();
    error DonorNotEligible();
    error RoundNotActive();
    error RoundDoesNotExist();
    error MatchingAlreadyDistributed();
    error NoMatchingToClaim();
    error MatchingAlreadyClaimed();
    error InsufficientMatchingPool();

    constructor(uint256 roundDuration) {
        _roundDuration = roundDuration;
        _createRound();
    }

    function projectCount() public view override returns (uint256) {
        return _projectCount;
    }

    function currentRound() public view override returns (uint256) {
        return _currentRound;
    }

    function rounds(uint256 roundId)
        public
        view
        override
        returns (
            uint256 matchingPool,
            bool active,
            uint256 startTime,
            uint256 endTime,
            bool matchingDistributed,
            bytes32 allocationRoot
        )
    {
        Round storage r = _rounds[roundId];
        return
            (
                r.matchingPool,
                r.active,
                r.startTime,
                r.endTime,
                r.matchingDistributed,
                r.allocationRoot
            );
    }

    function projects(uint256 projectId)
        public
        view
        override
        returns (
            address owner,
            string memory title,
            string memory description,
            uint256 totalDonations,
            bool active,
            uint256 matchingAllocated,
            bool matchingClaimed
        )
    {
        Project storage p = _projects[projectId];
        return (
            p.owner,
            p.title,
            p.description,
            p.totalDonations,
            p.active,
            p.matchingAllocated,
            p.matchingClaimed
        );
    }

    function contribution(uint256 projectId, address donor) public view override returns (uint256) {
        return _contributions[projectId][donor];
    }

    function donorCount(uint256 projectId) public view override returns (uint256) {
        return _donors[projectId].length;
    }

    function donors(uint256 projectId, uint256 index) public view override returns (address) {
        return _donors[projectId][index];
    }

    function eligibilityRoot() public view override returns (bytes32) {
        return _eligibilityRoot;
    }

    function isEligible(address account) public view override returns (bool) {
        return _eligible[account];
    }

    function registerProject(string calldata title, string calldata description)
        public
        override
        nonReentrant
        returns (uint256)
    {
        uint256 projectId = _projectCount + 1;
        _projectCount = projectId;
        _projects[projectId] = Project({
            owner: msg.sender,
            title: title,
            description: description,
            totalDonations: 0,
            active: true,
            matchingAllocated: 0,
            matchingClaimed: false
        });
        emit ProjectRegistered(projectId, msg.sender, title);
        return projectId;
    }

    function donate(uint256 projectId) public payable override nonReentrant {
        Project storage p = _projects[projectId];
        if (!p.active || p.owner == address(0)) {
            revert ProjectNotActive();
        }
        if (msg.value == 0) {
            revert ZeroDonation();
        }
        if (_eligibilityRoot != bytes32(0) && !_eligible[msg.sender]) {
            revert DonorNotEligible();
        }
        _contributions[projectId][msg.sender] += msg.value;
        if (_contributions[projectId][msg.sender] == msg.value) {
            _donors[projectId].push(msg.sender);
        }
        p.totalDonations += msg.value;
        emit Donated(projectId, msg.sender, msg.value);
    }

    function sponsor() public payable override nonReentrant {
        if (msg.value == 0) {
            revert ZeroDonation();
        }
        _rounds[_currentRound].matchingPool += msg.value;
        emit MatchingSponsored(msg.sender, msg.value);
    }

    function createRound() public override onlyOwner nonReentrant {
        _createRound();
        emit RoundCreated(
            _currentRound, _rounds[_currentRound].startTime, _rounds[_currentRound].endTime
        );
    }

    function _createRound() internal {
        _currentRound += 1;
        _rounds[_currentRound] = Round({
            matchingPool: 0,
            active: true,
            startTime: block.timestamp,
            endTime: block.timestamp + _roundDuration,
            matchingDistributed: false,
            allocationRoot: bytes32(0)
        });
    }

    function distributeMatching() public override onlyOwner nonReentrant {
        Round storage r = _rounds[_currentRound];
        if (!r.active) {
            revert RoundNotActive();
        }
        if (r.matchingDistributed) {
            revert MatchingAlreadyDistributed();
        }
        if (r.matchingPool == 0) {
            revert InsufficientMatchingPool();
        }

        uint256[] memory raw = new uint256[](_projectCount);
        uint256 totalRaw = 0;
        for (uint256 i = 1; i <= _projectCount; i++) {
            Project storage p = _projects[i];
            if (!p.active) {
                continue;
            }
            uint256 sumSqrt = 0;
            address[] memory projectDonors = _donors[i];
            for (uint256 j = 0; j < projectDonors.length; j++) {
                sumSqrt += sqrt(_contributions[i][projectDonors[j]]);
            }
            uint256 r_ = sumSqrt * sumSqrt;
            raw[i - 1] = r_;
            totalRaw += r_;
        }

        if (totalRaw == 0) {
            revert InsufficientMatchingPool();
        }

        uint256 totalMatching = 0;
        for (uint256 i = 1; i <= _projectCount; i++) {
            if (raw[i - 1] == 0) {
                continue;
            }
            uint256 matchAmount = (r.matchingPool * raw[i - 1]) / totalRaw;
            _projects[i].matchingAllocated += matchAmount;
            totalMatching += matchAmount;
        }

        r.matchingDistributed = true;
        r.allocationRoot = keccak256(abi.encodePacked(raw, totalMatching));
        emit MatchingDistributed(_currentRound, totalMatching);
    }

    function claimMatching(uint256 projectId) public override nonReentrant {
        Project storage p = _projects[projectId];
        if (p.owner == address(0)) {
            revert ProjectDoesNotExist();
        }
        if (p.matchingAllocated == 0 || p.matchingClaimed) {
            revert NoMatchingToClaim();
        }
        if (msg.sender != p.owner) {
            revert ProjectNotActive();
        }
        uint256 amount = p.matchingAllocated;
        p.matchingClaimed = true;
        p.matchingAllocated = 0;
        payable(p.owner).transfer(amount);
        emit MatchingClaimed(projectId, p.owner, amount);
    }

    function setEligibilityRoot(bytes32 root) public override onlyOwner {
        _eligibilityRoot = root;
    }

    function addEligible(address account) public onlyOwner {
        _eligible[account] = true;
    }

    function removeEligible(address account) public onlyOwner {
        _eligible[account] = false;
    }

    function sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) {
            return 0;
        }
        uint256 z = x;
        uint256 y = (x + 1) / 2;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
        return z;
    }
}
