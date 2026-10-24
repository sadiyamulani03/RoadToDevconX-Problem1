// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC5564Announcer} from "./interfaces/IERC5564Announcer.sol";

/// @title ERC5564Announcer
/// @notice Permissionless singleton-style announcer for ERC-5564 stealth payments.
/// @dev This contract is intentionally stateless. It can be deployed at the canonical
///      ERC-5564 address with a deterministic deployment mechanism, or any deployment
///      address can be configured by clients.
contract ERC5564Announcer is IERC5564Announcer {
    /// @inheritdoc IERC5564Announcer
    function announce(
        uint256 schemeId,
        address stealthAddress,
        bytes calldata ephemeralPubKey,
        bytes calldata metadata
    ) external override {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
