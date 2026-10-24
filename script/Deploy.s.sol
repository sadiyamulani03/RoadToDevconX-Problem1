// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {ERC5564Announcer} from "../contracts/ERC5564Announcer.sol";
import {StealthPaymentRouter} from "../contracts/StealthPaymentRouter.sol";

/// @notice Deploys the announcer and router. Use `forge script ... --broadcast`
/// with a local Anvil node or a configured RPC endpoint.
contract Deploy is Script {
    function run() external returns (ERC5564Announcer announcer, StealthPaymentRouter router) {
        vm.startBroadcast();
        announcer = new ERC5564Announcer();
        router = new StealthPaymentRouter(address(announcer));
        vm.stopBroadcast();
    }
}
