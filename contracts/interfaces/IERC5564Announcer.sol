// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IERC5564Announcer
/// @notice Interface for the singleton ERC-5564 announcement contract.
/// @dev Event and function signatures match ERC-5564 exactly.
interface IERC5564Announcer {
    /// @dev Emitted when sending something to a stealth address.
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    /// @dev Called by integrators to emit an Announcement event.
    /// @param schemeId The integer specifying the applied stealth address scheme.
    /// @param stealthAddress The computed stealth address for the recipient.
    /// @param ephemeralPubKey Ephemeral public key used by the sender.
    /// @param metadata Arbitrary data whose first byte MUST be the view tag for scheme 1.
    function announce(
        uint256 schemeId,
        address stealthAddress,
        bytes calldata ephemeralPubKey,
        bytes calldata metadata
    ) external;
}
