// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";

/// @title MockSystem — test-only stand-in for the Reactive system contract.
/// @notice Records subscriptions and callback requests so local tests can assert
///         the full loop without a live Reactive network. Never deployed to a
///         real chain. On a local Hardhat node, set its runtime code at the
///         system address (0x8888...) with `hardhat_setCode`.
contract MockSystem is ISystemContract {
    struct Subscription {
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
    }

    Subscription[] public subscriptions;
    CallbackConfiguration_V_1_0[] public callbacks;

    event Subscribed(uint256 chainId, address contractAddress, uint256 topic0);
    event CallbackRequested(uint256 chainId, address recipient, uint64 gasLimit, bytes payload);

    receive() external payable override {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function subscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external override {
        subscriptions.push(
            Subscription({
                chainId: chainId_,
                contractAddress: contract_,
                topic0: topic0_,
                topic1: topic1_,
                topic2: topic2_,
                topic3: topic3_
            })
        );
        emit Subscribed(chainId_, contract_, topic0_);
    }

    function unsubscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external override {
        for (uint256 i = 0; i < subscriptions.length; i++) {
            Subscription storage s = subscriptions[i];
            if (
                s.chainId == chainId_ &&
                s.contractAddress == contract_ &&
                s.topic0 == topic0_ &&
                s.topic1 == topic1_ &&
                s.topic2 == topic2_ &&
                s.topic3 == topic3_
            ) {
                subscriptions[i] = subscriptions[subscriptions.length - 1];
                subscriptions.pop();
                break;
            }
        }
    }

    function requestCallback(CallbackVersion, bytes memory config_) external override {
        CallbackConfiguration_V_1_0 memory cfg = abi.decode(config_, (CallbackConfiguration_V_1_0));
        _recordCallback(cfg);
    }

    function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config_) external override {
        _recordCallback(config_);
    }

    function _recordCallback(CallbackConfiguration_V_1_0 memory config_) internal {
        callbacks.push(config_);
        emit CallbackRequested(config_.chainId, config_.recipient, config_.gasLimit, config_.payload);
    }

    function subscriptionCount() external view returns (uint256) {
        return subscriptions.length;
    }

    function callbackCount() external view returns (uint256) {
        return callbacks.length;
    }
}
