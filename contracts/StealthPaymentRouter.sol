// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC5564Announcer} from "./interfaces/IERC5564Announcer.sol";

/// @title StealthPaymentRouter
/// @notice Atomically announces an ERC-5564 payment and transfers ETH to the stealth address.
/// @dev The value transfer happens before the announcement. If the transfer fails, no
///      announcement is ever emitted. If the announcement fails, the transfer is reverted
///      with the rest of the transaction. Either way the operation is atomic.
contract StealthPaymentRouter {
    error ZeroAnnouncer();
    error ZeroStealthAddress();
    error ZeroValue();
    error TransferFailed();
    error DirectEthNotAllowed();

    IERC5564Announcer public immutable ANNOUNCER;

    constructor(address announcer_) {
        if (announcer_ == address(0)) revert ZeroAnnouncer();
        ANNOUNCER = IERC5564Announcer(announcer_);
    }

    /// @notice Address of the ERC-5564 announcer used by this router.
    function announcer() external view returns (address) {
        return address(ANNOUNCER);
    }

    /// @notice Announce and pay a stealth address in one atomic transaction.
    /// @param schemeId ERC-5564 scheme identifier (1 for secp256k1 with view tags).
    /// @param stealthAddress Recipient stealth address.
    /// @param ephemeralPubKey Sender's ephemeral public key.
    /// @param metadata ERC-5564 metadata; the first byte MUST be the view tag.
    function pay(
        uint256 schemeId,
        address stealthAddress,
        bytes calldata ephemeralPubKey,
        bytes calldata metadata
    ) external payable {
        if (stealthAddress == address(0)) {
            revert ZeroStealthAddress();
        }
        if (msg.value == 0) revert ZeroValue();

        (bool success,) = stealthAddress.call{value: msg.value}("");
        if (!success) revert TransferFailed();

        ANNOUNCER.announce(schemeId, stealthAddress, ephemeralPubKey, metadata);
    }

    /// @dev Reject accidental direct ETH transfers so funds cannot become stuck.
    receive() external payable {
        revert DirectEthNotAllowed();
    }
}
