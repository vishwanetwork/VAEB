// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockSwapRouter
 * @notice Implements Uniswap V3 SwapRouter's exactInputSingle interface for testnet.
 *         Performs 1:1 stablecoin swaps (USDC ↔ USDT) using its own token reserves.
 *         Pre-fund this contract with both tokens during deployment.
 *
 *         On mainnet, replace this address with the real Uniswap V3 SwapRouter.
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract MockSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    event Swap(
        address indexed tokenIn,
        address indexed tokenOut,
        address indexed recipient,
        uint256 amountIn,
        uint256 amountOut
    );

    /**
     * @notice Swap tokenIn for tokenOut at 1:1 rate (stablecoin mock).
     *         Caller must have approved this contract to spend tokenIn.
     */
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut)
    {
        require(block.timestamp <= params.deadline, "Transaction expired");
        require(params.amountIn > 0, "Amount must be > 0");

        // 1:1 swap for same-decimal stablecoins
        amountOut = params.amountIn;
        require(amountOut >= params.amountOutMinimum, "Insufficient output amount");

        // Check this contract has enough tokenOut reserves
        require(
            IERC20(params.tokenOut).balanceOf(address(this)) >= amountOut,
            "Insufficient liquidity"
        );

        // Pull tokenIn from caller
        require(
            IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn),
            "TransferFrom failed"
        );

        // Send tokenOut to recipient
        require(
            IERC20(params.tokenOut).transfer(params.recipient, amountOut),
            "Transfer failed"
        );

        emit Swap(params.tokenIn, params.tokenOut, params.recipient, params.amountIn, amountOut);
    }
}
