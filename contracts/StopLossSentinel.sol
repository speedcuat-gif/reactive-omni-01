// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";

/// @title StopLossSentinel — reactive contract watching a price feed on the origin chain.
/// @notice Subscribes to PriceUpdated events from the feed on Ethereum Sepolia.
///         On every event it checks the armed orders: a stop-loss fires when the
///         price falls to or below its stop, a take-profit fires when the price
///         rises to or above its target. For each order that trips it requests a
///         callback to the vault, which releases the escrowed funds to the user.
///         No bot, no keeper, no off-chain watcher — the rule lives on-chain.
/// @dev Reactive contract on Reactive Lasna (chain 5318007). The origin chain is
///      Ethereum Sepolia (11155111) and the destination is the same chain, so the
///      callback returns to the vault that holds the funds.
///      Orders are armed on this contract by their owner (armOrder) and mirrored
///      in the vault by the deposit; the vault is the source of truth for funds.
contract StopLossSentinel is AbstractReactive {
    uint256 public immutable ORIGIN_CHAIN_ID;
    address public immutable FEED;
    address public owner;
    address public vault;

    struct ArmedOrder {
        address user;
        uint256 orderId;
        uint256 stopPrice;
        bool isTakeProfit;
        bool triggered;
    }

    uint256[] public armedOrderIds;
    mapping(uint256 => ArmedOrder) public armedOrders;

    event OrderArmed(uint256 indexed orderId, address indexed user, uint256 stopPrice, bool isTakeProfit);
    event OrderTriggered(uint256 indexed orderId, address indexed user, uint256 price, uint256 timestamp);
    event VaultSet(address indexed vault);
    event CallbackRequested(uint256 indexed orderId, address indexed vault, uint256 timestamp);

    /// @param feed_ Price feed contract on the origin chain.
    /// @param originChainId_ Origin chain ID (Ethereum Sepolia: 11155111).
    constructor(address feed_, uint256 originChainId_) payable {
        require(feed_ != address(0), "feed is zero");
        owner = msg.sender;
        FEED = feed_;
        ORIGIN_CHAIN_ID = originChainId_;
        SYSTEM.subscribe(
            originChainId_,
            feed_,
            PRICE_TOPIC0(),
            REACTIVE_IGNORE,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
    }

    /// @notice Topic0 of PriceUpdated(uint256,uint256), computed at runtime to
    ///         avoid a hardcoded-constant typo.
    function PRICE_TOPIC0() public pure returns (uint256) {
        return uint256(keccak256("PriceUpdated(uint256,uint256)"));
    }

    /// @notice Point the sentinel at the vault that holds the escrow. Owner-only.
    function setVault(address vault_) external {
        require(msg.sender == owner, "not owner");
        require(vault_ != address(0), "vault is zero");
        vault = vault_;
        emit VaultSet(vault_);
    }

    /// @notice Arm an order for watching. Caller must be the order's user.
    /// @dev Mirrors a deposit made in the vault (same orderId). The vault stays
    ///      the source of truth for funds; arming only registers the trigger.
    function armOrder(uint256 orderId_, uint256 stopPrice_, bool isTakeProfit_) external {
        require(stopPrice_ > 0, "stop price is zero");
        require(armedOrders[orderId_].user == address(0), "order already armed");
        armedOrders[orderId_] = ArmedOrder({
            user: msg.sender,
            orderId: orderId_,
            stopPrice: stopPrice_,
            isTakeProfit: isTakeProfit_,
            triggered: false
        });
        armedOrderIds.push(orderId_);
        emit OrderArmed(orderId_, msg.sender, stopPrice_, isTakeProfit_);
    }

    /// @notice Called by the system contract when a subscribed event is seen.
    /// @dev Decodes (price, timestamp) from the log data and checks every armed
    ///      order. Tripped orders are marked before the callback is requested,
    ///      so a duplicate delivery can never fire the same order twice.
    function react(LogRecord calldata log_) external override onlySystem {
        require(log_.contractAddress == FEED, "unexpected origin contract");
        require(log_.topic0 == PRICE_TOPIC0(), "unexpected topic");
        (uint256 price, ) = abi.decode(log_.data, (uint256, uint256));
        require(vault != address(0), "vault not set");
        for (uint256 i = 0; i < armedOrderIds.length; i++) {
            ArmedOrder storage order = armedOrders[armedOrderIds[i]];
            if (order.triggered) continue;
            bool trips = order.isTakeProfit
                ? price >= order.stopPrice
                : price <= order.stopPrice;
            if (!trips) continue;
            order.triggered = true;
            emit OrderTriggered(order.orderId, order.user, price, block.timestamp);
            bytes memory payload = abi.encodeWithSignature(
                "executeStopLoss(address,address,uint256,uint256)",
                address(0),
                order.user,
                order.orderId,
                price
            );
            SYSTEM.requestCallbackV_1_0(
                ISystemContract.CallbackConfiguration_V_1_0({
                    chainId: ORIGIN_CHAIN_ID,
                    recipient: vault,
                    gasLimit: 300000,
                    payload: payload
                })
            );
            emit CallbackRequested(order.orderId, vault, block.timestamp);
        }
    }

    /// @notice Settle outstanding debt to the system contract from this contract's balance.
    function coverDebt() external {
        _coverDebt();
    }

    function armedOrderCount() external view returns (uint256) {
        return armedOrderIds.length;
    }
}
