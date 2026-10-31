// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

abstract contract Ownable {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error OwnableUnauthorized(address account);
    error OwnableInvalidAddress(address account);

    constructor() {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function owner() public view virtual returns (address) {
        return _owner;
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) {
            revert OwnableUnauthorized(msg.sender);
        }
        _;
    }

    function renounceOwnership() public virtual onlyOwner {
        emit OwnershipTransferred(_owner, address(0));
        _owner = address(0);
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) {
            revert OwnableInvalidAddress(newOwner);
        }
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }
}
