// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IQuadraticFunding {
    event ProjectRegistered(uint256 indexed projectId, address indexed owner, string title);
    event Donated(uint256 indexed projectId, address indexed donor, uint256 amount);
    event MatchingSponsored(address indexed sponsor, uint256 amount);
    event RoundCreated(uint256 indexed roundId, uint256 startTime, uint256 endTime);
    event MatchingDistributed(uint256 indexed roundId, uint256 totalMatching);
    event MatchingClaimed(uint256 indexed projectId, address indexed owner, uint256 amount);

    function projectCount() external view returns (uint256);
    function currentRound() external view returns (uint256);
    function rounds(uint256 roundId)
        external
        view
        returns (
            uint256 matchingPool,
            bool active,
            uint256 startTime,
            uint256 endTime,
            bool matchingDistributed,
            bytes32 allocationRoot
        );
    function projects(uint256 projectId)
        external
        view
        returns (
            address owner,
            string memory title,
            string memory description,
            uint256 totalDonations,
            bool active,
            uint256 matchingAllocated,
            bool matchingClaimed
        );
    function contribution(uint256 projectId, address donor) external view returns (uint256);
    function donorCount(uint256 projectId) external view returns (uint256);
    function donors(uint256 projectId, uint256 index) external view returns (address);
    function eligibilityRoot() external view returns (bytes32);
    function registerProject(string calldata title, string calldata description)
        external
        returns (uint256);
    function donate(uint256 projectId) external payable;
    function sponsor() external payable;
    function createRound() external;
    function distributeMatching() external;
    function claimMatching(uint256 projectId) external;
    function setEligibilityRoot(bytes32 root) external;
    function isEligible(address account) external view returns (bool);
}
