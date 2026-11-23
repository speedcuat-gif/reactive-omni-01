// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title MockCallbackProxy — test-only stand-in for a destination-chain callback proxy.
/// @notice Implements IPayable (debt is always zero) and forwards calls to the
///         target so local tests can exercise `onlyServiceProvider`-guarded
///         callbacks. Never deployed to a real chain.
contract MockCallbackProxy {
    receive() external payable {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    /// @notice Call `target_` with `data_` as the proxy (msg.sender at the target is this contract).
    function forward(address target_, bytes calldata data_) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target_.call(data_);
        require(ok, "forward failed");
        return ret;
    }
}
