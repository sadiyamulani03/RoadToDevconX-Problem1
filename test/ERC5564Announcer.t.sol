// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC5564Announcer} from "../contracts/ERC5564Announcer.sol";
import {StealthPaymentRouter} from "../contracts/StealthPaymentRouter.sol";

contract RejectingReceiver {
    receive() external payable {
        revert("NO_ETH");
    }
}

contract ERC5564AnnouncerTest is Test {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    ERC5564Announcer private announcer;
    StealthPaymentRouter private router;

    address private constant STEALTH = address(0xBEEF);
    bytes private ephemeralPubKey =
        hex"02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    bytes private metadata =
        hex"42eeeeeeeeEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE0000000000000000000000000000000000000000000000000000000000000001";

    function setUp() public {
        announcer = new ERC5564Announcer();
        router = new StealthPaymentRouter(address(announcer));
        vm.deal(address(this), 100 ether);
    }

    function testAnnouncerEmitsExactERC5564Event() public {
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(this), ephemeralPubKey, metadata);

        announcer.announce(1, STEALTH, ephemeralPubKey, metadata);
    }

    function testRouterAtomicallyPaysAndAnnounces() public {
        uint256 amount = 1 ether;

        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(router), ephemeralPubKey, metadata);

        router.pay{value: amount}(1, STEALTH, ephemeralPubKey, metadata);

        assertEq(STEALTH.balance, amount);
        assertEq(address(router).balance, 0);
        assertEq(router.announcer(), address(announcer));
    }

    function testRouterRevertsAndDropsAnnouncementWhenTransferFails() public {
        RejectingReceiver rejector = new RejectingReceiver();

        vm.recordLogs();
        vm.expectRevert(StealthPaymentRouter.TransferFailed.selector);
        router.pay{value: 1 ether}(1, address(rejector), ephemeralPubKey, metadata);

        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(address(rejector).balance, 0);
    }

    function testRouterRejectsZeroValue() public {
        vm.expectRevert(StealthPaymentRouter.ZeroValue.selector);
        router.pay{value: 0}(1, STEALTH, ephemeralPubKey, metadata);
    }

    function testRouterRejectsZeroStealthAddress() public {
        vm.expectRevert(StealthPaymentRouter.ZeroStealthAddress.selector);
        router.pay{value: 1 ether}(1, address(0), ephemeralPubKey, metadata);
    }

    function testRouterRejectsDirectEthTransfer() public {
        vm.expectRevert(StealthPaymentRouter.DirectEthNotAllowed.selector);
        payable(address(router)).transfer(1 ether);
    }

    function testRouterConstructorRejectsZeroAnnouncer() public {
        vm.expectRevert(StealthPaymentRouter.ZeroAnnouncer.selector);
        new StealthPaymentRouter(address(0));
    }
}
