// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

abstract contract ReentrancyGuard {
    uint256 private _status;

    uint256 constant _NOT_ENTERED = 0;
    uint256 constant _ENTERED = 1;

    error ReentrancyGuardReentrancy();

    constructor() {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        if (_status == _ENTERED) {
            revert ReentrancyGuardReentrancy();
        }
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}
