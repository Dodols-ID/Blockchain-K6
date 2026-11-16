// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MusicLicensing — MVP Minggu 2 (Kelompok 6)
/// @notice Registrasi lagu + pembelian lisensi sinkronisasi langsung dari pencipta ke pengguna,
///         dengan auto-split royalti, withdraw (pola pull), dan penanganan error.
/// @dev    Perubahan dari minggu 1:
///         - Token pembayaran bisa native (POL) atau ERC-20 (mis. IDRX, stablecoin Rupiah).
///         - Harga minimum lisensi agar fee efektif tidak pernah > 2% (dulu bisa 20%).
///         - Jeda pembelian darurat oleh admin; withdraw TIDAK pernah dijeda.
///         - Proteksi token fee-on-transfer & token yang tidak mengembalikan bool.
contract MusicLicensing {
    // ---------------------------------------------------------------------
    // Konstanta & konfigurasi
    // ---------------------------------------------------------------------
    uint16 public constant BPS_DENOMINATOR = 10_000; // 100% = 10.000 bps
    uint16 public constant PROTOCOL_FEE_BPS = 100;   // 1%
    uint16 public constant MAX_EFFECTIVE_FEE_BPS = 200; // fee efektif paling tinggi 2%
    uint8  public constant MAX_COLLABORATORS = 10;   // batas gas loop split

    address public immutable admin;          // hanya untuk jeda darurat
    address public immutable treasury;       // penerima micro-protocol fee
    address public immutable paymentToken;   // address(0) = native POL; selain itu ERC-20
    uint256 public immutable minProtocolFee; // padanan "Rp1.000" dalam satuan token
    uint256 public immutable minLicensePrice; // = minProtocolFee * 10000 / 200 → fee ≤ 2%

    bool public purchasesPaused;

    // ---------------------------------------------------------------------
    // Struktur data
    // ---------------------------------------------------------------------
    struct Track {
        address owner;          // pencipta utama (yang mendaftarkan)
        string  ipfsCid;        // CID audio + metadata di IPFS (Pinata)
        bytes32 termsHash;      // hash dokumen syarat lisensi (Ricardian contract)
        uint256 price;          // harga lisensi dalam satuan terkecil token
        bool    active;
        uint64  registeredAt;
        address[] payees;       // dompet kolaborator
        uint16[]  sharesBps;    // porsi tiap kolaborator, total 10.000
    }

    struct License {
        uint256 trackId;
        address licensee;
        uint256 pricePaid;
        bytes32 termsHash;      // syarat yang disetujui pembeli saat beli
        uint64  purchasedAt;
    }

    uint256 public trackCount;
    uint256 public licenseCount;
    uint256 public totalPending;   // total utang kontrak ke semua pihak (untuk audit invariant)

    mapping(uint256 => Track)   private _tracks;
    mapping(uint256 => License) public  licenses;
    mapping(bytes32 => bool)    public  cidRegistered;
    mapping(address => uint256) public  pendingWithdrawals;
    mapping(uint256 => mapping(address => bool)) public hasLicense;

    // ---------------------------------------------------------------------
    // Event
    // ---------------------------------------------------------------------
    event TrackRegistered(uint256 indexed trackId, address indexed owner, string ipfsCid, uint256 price, bytes32 termsHash);
    event TrackStatusChanged(uint256 indexed trackId, bool active);
    event TrackPriceChanged(uint256 indexed trackId, uint256 newPrice);
    event LicensePurchased(uint256 indexed licenseId, uint256 indexed trackId, address indexed licensee, uint256 pricePaid, bytes32 termsHash);
    event RoyaltyCredited(uint256 indexed licenseId, address indexed payee, uint256 amount);
    event ProtocolFeeCredited(uint256 indexed licenseId, uint256 amount);
    event Withdrawn(address indexed payee, uint256 amount);
    event PurchasesPaused(bool paused);

    // ---------------------------------------------------------------------
    // Error
    // ---------------------------------------------------------------------
    error InvalidShareTotal(uint256 total);
    error InvalidCollaborators();
    error ZeroAddress();
    error InvalidToken();
    error EmptyCid();
    error DuplicateCid();
    error PriceTooLow(uint256 price, uint256 minPrice);
    error TrackNotFound(uint256 trackId);
    error TrackNotActive(uint256 trackId);
    error InsufficientPayment(uint256 sent, uint256 required);
    error UnexpectedNativePayment();
    error TokenAmountMismatch(uint256 expected, uint256 received);
    error TermsMismatch(bytes32 expected, bytes32 given);
    error NotTrackOwner(uint256 trackId);
    error NotAdmin();
    error PurchasingPaused();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();

    uint256 private _lock = 1;
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address treasury_, address paymentToken_, uint256 minProtocolFee_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (paymentToken_ != address(0) && paymentToken_.code.length == 0) revert InvalidToken();
        if (minProtocolFee_ == 0) revert PriceTooLow(0, 1);
        admin = msg.sender;
        treasury = treasury_;
        paymentToken = paymentToken_;
        minProtocolFee = minProtocolFee_;
        minLicensePrice = (minProtocolFee_ * BPS_DENOMINATOR) / MAX_EFFECTIVE_FEE_BPS;
    }

    // ---------------------------------------------------------------------
    // Registrasi
    // ---------------------------------------------------------------------

    /// @notice Musisi mendaftarkan lagu beserta aturan pembagian royalti.
    /// @dev    Aturan split dikunci saat registrasi: tidak ada fungsi untuk mengubahnya.
    function registerTrack(
        string calldata ipfsCid,
        bytes32 termsHash,
        uint256 price,
        address[] calldata payees,
        uint16[] calldata sharesBps
    ) external returns (uint256 trackId) {
        if (bytes(ipfsCid).length == 0) revert EmptyCid();
        bytes32 cidKey = keccak256(bytes(ipfsCid));
        if (cidRegistered[cidKey]) revert DuplicateCid();
        _validateSplit(payees, sharesBps);
        _checkPrice(price);

        trackId = ++trackCount;
        cidRegistered[cidKey] = true;

        Track storage t = _tracks[trackId];
        t.owner = msg.sender;
        t.ipfsCid = ipfsCid;
        t.termsHash = termsHash;
        t.price = price;
        t.active = true;
        t.registeredAt = uint64(block.timestamp);
        t.payees = payees;
        t.sharesBps = sharesBps;

        emit TrackRegistered(trackId, msg.sender, ipfsCid, price, termsHash);
    }

    // ---------------------------------------------------------------------
    // Pembelian + auto-split
    // ---------------------------------------------------------------------

    /// @notice Pembeli membayar lisensi; royalti langsung dikreditkan ke tiap kolaborator.
    /// @dev    Native: kirim msg.value = harga. ERC-20: approve dulu, msg.value harus 0.
    /// @param  acceptedTermsHash hash syarat yang dilihat pembeli di UI — harus sama dengan on-chain.
    function purchaseLicense(uint256 trackId, bytes32 acceptedTermsHash)
        external
        payable
        nonReentrant
        returns (uint256 licenseId)
    {
        if (purchasesPaused) revert PurchasingPaused();
        Track storage t = _getTrack(trackId);
        if (!t.active) revert TrackNotActive(trackId);
        if (acceptedTermsHash != t.termsHash) revert TermsMismatch(t.termsHash, acceptedTermsHash);

        uint256 price = t.price;
        _collectPayment(price);

        licenseId = ++licenseCount;
        licenses[licenseId] = License({
            trackId: trackId,
            licensee: msg.sender,
            pricePaid: price,
            termsHash: t.termsHash,
            purchasedAt: uint64(block.timestamp)
        });
        hasLicense[trackId][msg.sender] = true;

        _distribute(licenseId, t, price);
        emit LicensePurchased(licenseId, trackId, msg.sender, price, t.termsHash);
    }

    /// @notice Kolaborator/treasury menarik saldo royaltinya. Tidak pernah dijeda.
    function withdrawRoyalties() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0; // checks-effects-interactions
        totalPending -= amount;
        _payOut(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Pengelolaan
    // ---------------------------------------------------------------------
    function setTrackActive(uint256 trackId, bool active) external {
        Track storage t = _getTrack(trackId);
        if (t.owner != msg.sender) revert NotTrackOwner(trackId);
        t.active = active;
        emit TrackStatusChanged(trackId, active);
    }

    function setTrackPrice(uint256 trackId, uint256 newPrice) external {
        Track storage t = _getTrack(trackId);
        if (t.owner != msg.sender) revert NotTrackOwner(trackId);
        _checkPrice(newPrice);
        t.price = newPrice;
        emit TrackPriceChanged(trackId, newPrice);
    }

    /// @notice Jeda darurat pembelian baru (mis. ada bug). Saldo tetap bisa ditarik.
    function setPurchasesPaused(bool paused) external {
        if (msg.sender != admin) revert NotAdmin();
        purchasesPaused = paused;
        emit PurchasesPaused(paused);
    }

    // ---------------------------------------------------------------------
    // View
    // ---------------------------------------------------------------------
    /// @notice fee = max(1% harga, minProtocolFee); dengan harga ≥ minLicensePrice, fee ≤ 2%.
    function protocolFeeFor(uint256 price) public view returns (uint256) {
        uint256 pct = (price * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        return pct > minProtocolFee ? pct : minProtocolFee;
    }

    function getTrack(uint256 trackId)
        external
        view
        returns (
            address owner,
            string memory ipfsCid,
            bytes32 termsHash,
            uint256 price,
            bool active,
            uint64 registeredAt,
            address[] memory payees,
            uint16[] memory sharesBps
        )
    {
        Track storage t = _getTrack(trackId);
        return (t.owner, t.ipfsCid, t.termsHash, t.price, t.active, t.registeredAt, t.payees, t.sharesBps);
    }

    function verifyLicense(uint256 licenseId, address who) external view returns (bool valid, uint256 trackId) {
        License storage l = licenses[licenseId];
        return (l.licensee == who && l.licensee != address(0), l.trackId);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------
    function _checkPrice(uint256 price) private view {
        if (price < minLicensePrice) revert PriceTooLow(price, minLicensePrice);
    }

    function _collectPayment(uint256 price) private {
        if (paymentToken == address(0)) {
            if (msg.value != price) revert InsufficientPayment(msg.value, price);
            return;
        }
        if (msg.value != 0) revert UnexpectedNativePayment();
        uint256 before = _tokenBalance();
        _callToken(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), price)); // transferFrom
        uint256 received = _tokenBalance() - before;
        if (received != price) revert TokenAmountMismatch(price, received); // tolak token fee-on-transfer
    }

    function _distribute(uint256 licenseId, Track storage t, uint256 price) private {
        uint256 fee = protocolFeeFor(price);
        pendingWithdrawals[treasury] += fee;
        emit ProtocolFeeCredited(licenseId, fee);

        uint256 net = price - fee;
        uint256 n = t.payees.length;
        uint256 distributed;
        for (uint256 i; i < n; ++i) {
            uint256 amount = (i == n - 1)
                ? net - distributed                       // sisa pembulatan ke kolaborator terakhir
                : (net * t.sharesBps[i]) / BPS_DENOMINATOR;
            distributed += amount;
            pendingWithdrawals[t.payees[i]] += amount;
            emit RoyaltyCredited(licenseId, t.payees[i], amount);
        }
        totalPending += price;
    }

    function _payOut(address to, uint256 amount) private {
        if (paymentToken == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _callToken(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
        }
    }

    /// @dev Mendukung token yang mengembalikan bool maupun yang tidak mengembalikan apa-apa.
    function _callToken(bytes memory data) private {
        (bool ok, bytes memory ret) = paymentToken.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _tokenBalance() private view returns (uint256 bal) {
        (bool ok, bytes memory ret) = paymentToken.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length < 32) revert InvalidToken();
        bal = abi.decode(ret, (uint256));
    }

    function _validateSplit(address[] calldata payees, uint16[] calldata sharesBps) private pure {
        uint256 n = payees.length;
        if (n == 0 || n != sharesBps.length || n > MAX_COLLABORATORS) revert InvalidCollaborators();
        uint256 total;
        for (uint256 i; i < n; ++i) {
            if (payees[i] == address(0)) revert ZeroAddress();
            if (sharesBps[i] == 0) revert InvalidCollaborators();
            for (uint256 j; j < i; ++j) {
                if (payees[j] == payees[i]) revert InvalidCollaborators();
            }
            total += sharesBps[i];
        }
        if (total != BPS_DENOMINATOR) revert InvalidShareTotal(total);
    }

    function _getTrack(uint256 trackId) private view returns (Track storage t) {
        t = _tracks[trackId];
        if (t.owner == address(0)) revert TrackNotFound(trackId);
    }
}
