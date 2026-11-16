// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Kontrak bantu KHUSUS untuk pengujian. Jangan di-deploy ke mainnet.

/// @notice ERC-20 minimal, dipakai sebagai pengganti IDRX di testnet/tes lokal.
contract MockIDRX {
    string public name = "Mock IDRX";
    string public symbol = "mIDRX";
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 decimals_) { decimals = decimals_; }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Token yang memotong 1% setiap transfer — harus DITOLAK kontrak.
contract FeeOnTransferToken is MockIDRX {
    constructor() MockIDRX(18) {}
    function _move(address from, address to, uint256 amount) internal override {
        uint256 burn = amount / 100;
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount - burn;
        totalSupply -= burn;
        emit Transfer(from, to, amount - burn);
    }
}

/// @notice Penerima yang selalu menolak POL — membuktikan pola pull mengisolasi kegagalan.
contract RevertingReceiver {
    function withdrawFrom(address licensing) external {
        (bool ok, bytes memory ret) = licensing.call(abi.encodeWithSignature("withdrawRoyalties()"));
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
    receive() external payable { revert("tolak"); }
}

/// @notice Penyerang reentrancy: saat menerima POL, mencoba withdraw lagi.
contract ReentrantPayee {
    address public licensing;
    uint256 public reentryAttempts;
    constructor(address licensing_) { licensing = licensing_; }

    function attack() external {
        (bool ok, bytes memory ret) = licensing.call(abi.encodeWithSignature("withdrawRoyalties()"));
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }

    receive() external payable {
        reentryAttempts++;
        // panggilan kedua harus gagal (Reentrancy) → seluruh withdraw dibatalkan
        (bool ok, bytes memory ret) = licensing.call(abi.encodeWithSignature("withdrawRoyalties()"));
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
}
