// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {QuadraticFunding} from "../contracts/QuadraticFunding.sol";

contract QuadraticFundingTest is Test {
    QuadraticFunding public qf;
    address public owner = address(0x1234);
    address public donorA = address(0x5678);
    address public donorB = address(0x9ABC);
    address public sponsor = address(0xDEF0);

    function setUp() public {
        vm.prank(owner);
        qf = new QuadraticFunding(30 days);
        vm.deal(donorA, 20 ether);
        vm.deal(donorB, 20 ether);
        vm.deal(sponsor, 100 ether);
        vm.deal(owner, 20 ether);
    }

    function test_register_project() public {
        vm.prank(owner);
        uint256 id = qf.registerProject("Green Park", "Community garden");
        assertEq(id, 1);
        (address o, string memory title,, uint256 total, bool active,,) = qf.projects(1);
        assertEq(o, owner);
        assertEq(keccak256(bytes(title)), keccak256(bytes("Green Park")));
        assertEq(total, 0);
        assert(active);
        assertEq(qf.projectCount(), 1);
    }

    function test_donate_records_contribution() public {
        vm.prank(owner);
        uint256 id = qf.registerProject("Project A", "desc");
        vm.prank(donorA);
        qf.donate{value: 1 ether}(id);
        assertEq(qf.contribution(id, donorA), 1 ether);
        (,,, uint256 total,,,) = qf.projects(id);
        assertEq(total, 1 ether);
        assertEq(qf.donorCount(id), 1);
    }

    function test_donate_zero_value_reverts() public {
        vm.prank(owner);
        uint256 id = qf.registerProject("Project A", "desc");
        vm.prank(donorA);
        vm.expectRevert();
        qf.donate(id);
    }

    function test_donate_records_contribution_from_multiple_donors() public {
        vm.prank(owner);
        uint256 id = qf.registerProject("Project A", "desc");
        vm.prank(donorA);
        qf.donate{value: 1 ether}(id);
        vm.prank(donorB);
        qf.donate{value: 2 ether}(id);
        assertEq(qf.contribution(id, donorA), 1 ether);
        assertEq(qf.contribution(id, donorB), 2 ether);
        assertEq(qf.donorCount(id), 2);
    }

    function test_sponsor_adds_to_pool() public {
        vm.prank(sponsor);
        qf.sponsor{value: 10 ether}();
        (uint256 pool,,,,,) = qf.rounds(1);
        assertEq(pool, 10 ether);
    }

    function test_donor_repeated_contribution_accumulates() public {
        vm.prank(owner);
        uint256 id = qf.registerProject("Project A", "desc");
        vm.prank(donorA);
        qf.donate{value: 1 ether}(id);
        vm.prank(donorA);
        qf.donate{value: 2 ether}(id);
        assertEq(qf.contribution(id, donorA), 3 ether);
        (,,, uint256 total,,,) = qf.projects(id);
        assertEq(total, 3 ether);
        assertEq(qf.donorCount(id), 1);
    }

    function test_only_owner_create_round() public {
        vm.prank(donorA);
        vm.expectRevert();
        qf.createRound();
    }
}
