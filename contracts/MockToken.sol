// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title MockToken — a minimal ERC20 used as the escrowed asset in the demo.
/// @notice "Sentinel USD" (sUSD), 18 decimals. The demo operator mints it to
///         fund test users. No bells, no whistles — just the ERC20 surface
///         the vault needs (transfer / transferFrom / approve / balanceOf).
contract MockToken {
    string public name = "Sentinel USD";
    string public symbol = "sUSD";
    uint8 public decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public owner;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        owner = msg.sender;
    }

    function mint(address to_, uint256 amount_) external {
        require(msg.sender == owner, "not owner");
        totalSupply += amount_;
        balanceOf[to_] += amount_;
        emit Transfer(address(0), to_, amount_);
    }

    function transfer(address to_, uint256 amount_) external returns (bool) {
        require(balanceOf[msg.sender] >= amount_, "insufficient balance");
        balanceOf[msg.sender] -= amount_;
        balanceOf[to_] += amount_;
        emit Transfer(msg.sender, to_, amount_);
        return true;
    }

    function approve(address spender_, uint256 amount_) external returns (bool) {
        allowance[msg.sender][spender_] = amount_;
        emit Approval(msg.sender, spender_, amount_);
        return true;
    }

    function transferFrom(address from_, address to_, uint256 amount_) external returns (bool) {
        require(balanceOf[from_] >= amount_, "insufficient balance");
        require(allowance[from_][msg.sender] >= amount_, "insufficient allowance");
        allowance[from_][msg.sender] -= amount_;
        balanceOf[from_] -= amount_;
        balanceOf[to_] += amount_;
        emit Transfer(from_, to_, amount_);
        return true;
    }
}
