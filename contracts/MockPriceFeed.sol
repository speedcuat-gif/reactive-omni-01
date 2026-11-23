// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title MockPriceFeed — a demo price feed for the Sentinel stop-loss executor.
/// @notice Emits PriceUpdated on every price change. In production this role is
///         played by a Chainlink feed or a Uniswap TWAP oracle; the sentinel
///         subscribes by event topic, so swapping the origin contract is a
///         one-line change (new feed address + same topic).
/// @dev Price is USD with 8 decimals (Chainlink style): 2000_00000000 = $2,000.00.
contract MockPriceFeed {
    uint256 public price;
    address public owner;

    event PriceUpdated(uint256 price, uint256 timestamp);

    constructor(uint256 initialPrice_) {
        owner = msg.sender;
        price = initialPrice_;
        emit PriceUpdated(initialPrice_, block.timestamp);
    }

    /// @notice Publish a new price. Restricted to the owner (the demo operator).
    function setPrice(uint256 price_) external {
        require(msg.sender == owner, "not owner");
        price = price_;
        emit PriceUpdated(price_, block.timestamp);
    }

    function getPrice() external view returns (uint256) {
        return price;
    }
}
