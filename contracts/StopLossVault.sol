// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";

interface IERC20Minimal {
    function transfer(address to_, uint256 amount_) external returns (bool);
    function transferFrom(address from_, address to_, uint256 amount_) external returns (bool);
    function balanceOf(address account_) external view returns (uint256);
}

/// @title StopLossVault — destination-chain vault holding escrowed sUSD.
/// @notice Users deposit sUSD and arm a stop-loss (or take-profit) price. When
///         the Sentinel reactive contract sees the price cross the threshold,
///         it requests a callback here and this contract releases the escrow
///         back to the user. The vault is the source of truth for funds: a
///         callback for a non-existent, cancelled or already-executed order
///         reverts, so a forged or duplicate trigger can never move money.
/// @dev Callback contract on the destination chain (Ethereum Sepolia).
///      Authenticates every callback twice: onlyServiceProvider (the call
///      came through the callback proxy) + onlyCallbackSender (the reactive
///      contract that requested it is the authorized Sentinel).
contract StopLossVault is AbstractCallback {
    IERC20Minimal public immutable TOKEN;

    struct Order {
        address user;
        uint256 amount;
        uint256 stopPrice; // USD with 8 decimals, same units as the price feed
        bool isTakeProfit; // false = stop-loss (fire when price <= stop), true = take-profit (fire when price >= target)
        bool active;
        bool executed;
    }

    uint256 public nextOrderId;
    mapping(uint256 => Order) public orders;

    event OrderCreated(uint256 indexed orderId, address indexed user, uint256 amount, uint256 stopPrice, bool isTakeProfit);
    event OrderCancelled(uint256 indexed orderId, address indexed user, uint256 amount);
    event StopLossExecuted(uint256 indexed orderId, address indexed user, uint256 amount, uint256 price, uint256 timestamp);

    /// @param callbackProxy_ Callback proxy on the destination chain.
    /// @param callbackSender_ The Sentinel reactive contract authorized to trigger callbacks.
    /// @param token_ The escrowed token (sUSD).
    constructor(IPayable callbackProxy_, address callbackSender_, address token_)
        payable
        AbstractCallback(callbackProxy_, callbackSender_)
    {
        TOKEN = IERC20Minimal(token_);
    }

    /// @notice Deposit sUSD and create an armed order. Caller must approve the vault first.
    function deposit(uint256 amount_, uint256 stopPrice_, bool isTakeProfit_) external returns (uint256 orderId) {
        require(amount_ > 0, "amount is zero");
        require(stopPrice_ > 0, "stop price is zero");
        require(TOKEN.transferFrom(msg.sender, address(this), amount_), "transfer failed");
        orderId = nextOrderId++;
        orders[orderId] = Order({
            user: msg.sender,
            amount: amount_,
            stopPrice: stopPrice_,
            isTakeProfit: isTakeProfit_,
            active: true,
            executed: false
        });
        emit OrderCreated(orderId, msg.sender, amount_, stopPrice_, isTakeProfit_);
    }

    /// @notice Callback entry point, invoked by the callback proxy on the Sentinel's request.
    /// @dev First argument is overwritten by the proxy with the reactive contract's
    ///      address; onlyCallbackSender verifies it is the authorized Sentinel.
    ///      `price_` is the feed price the Sentinel saw when it fired (for the event log).
    function executeStopLoss(address reactive_, address user_, uint256 orderId_, uint256 price_)
        external
        onlyServiceProvider
        onlyCallbackSender(reactive_)
    {
        Order storage order = orders[orderId_];
        require(order.active, "order not active");
        require(!order.executed, "order already executed");
        require(order.user == user_, "user mismatch");
        order.active = false;
        order.executed = true;
        require(TOKEN.transfer(order.user, order.amount), "payout failed");
        emit StopLossExecuted(orderId_, order.user, order.amount, price_, block.timestamp);
    }

    /// @notice Cancel an open order and get the escrow back. Only the order's user.
    function cancelOrder(uint256 orderId_) external {
        Order storage order = orders[orderId_];
        require(order.active, "order not active");
        require(order.user == msg.sender, "not the owner");
        order.active = false;
        require(TOKEN.transfer(order.user, order.amount), "refund failed");
        emit OrderCancelled(orderId_, order.user, order.amount);
    }

    /// @notice Settle outstanding callback debt from this contract's own balance.
    function coverDebt() external {
        _coverDebt();
    }

    function getOrder(uint256 orderId_) external view returns (Order memory) {
        return orders[orderId_];
    }
}
