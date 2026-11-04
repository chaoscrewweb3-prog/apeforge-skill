// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IApeToken {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev The reviewed registry binds a wallet and canonical Forge agent ID to
/// ApeForge/Core, Community or Partner status. Never trusts caller role labels.
interface IForgeJobEligibility {
    function canPostJobs(address actor, bytes32 agentIdHash) external view returns (bool);
}

/// @notice One reward, one human, fixed terms. Metadata is public forever.
/// @dev Canonical standard, non-rebasing, non-tax ERC20 only. Not audited or deployed.
contract MeatsuitJobs {
    enum State { Missing, Open, Assigned, Submitted, Rejected, Paid, Refunded }
    struct Job {
        address agent;
        address nominee;
        address worker;
        uint256 reward;
        uint256 workerCollateral;
        uint256 lockedCollateral;
        uint64 listingEnds;
        uint64 deliverySeconds;
        uint64 deliveryEnds;
        uint64 reviewEnds;
        uint8 skill;
        State state;
        bytes32 termsHash;
        bytes32 evidenceHash;
        bytes32 rejectionHash;
    }
    struct Terms { string agentId; string title; string brief; string acceptance; string category; string contact; string requiredSystems; string requiredKnowledge; string visual; uint32 estimatedMinutes; }
    IApeToken public immutable token;
    address public immutable treasury;
    IForgeJobEligibility public immutable eligibilityRegistry;
    /// @notice Human-selected v1 policy: silence after review pays the worker.
    bool public constant autoPayOnTimeout = true;
    uint256 public constant REVIEW_SECONDS = 3 days;
    uint256 public nextJobId = 1;
    uint256 public escrowed; // reward liabilities only
    uint256 public bonded; // independent worker collateral liabilities
    uint256 public constant collateralPolicyVersion = 1;
    uint256 private entered = 1;
    mapping(uint256 => Job) private jobs;
    mapping(uint256 => Terms) private terms;
    event Posted(uint256 indexed id, address indexed agent, uint256 reward, uint256 fee, bytes32 termsHash);
    event Nominated(uint256 indexed id, address indexed worker);
    event Accepted(uint256 indexed id, address indexed worker, uint64 deliveryEnds);
    event CollateralLocked(uint256 indexed id, address indexed worker, uint256 amount);
    event CollateralReturned(uint256 indexed id, address indexed worker, uint256 amount);
    event CollateralForfeited(uint256 indexed id, address indexed treasury, uint256 amount);
    event Submitted(uint256 indexed id, bytes32 evidenceHash, uint64 reviewEnds);
    event Rejected(uint256 indexed id, bytes32 reasonHash);
    event Paid(uint256 indexed id, address indexed worker, uint256 amount, bool timedOut);
    event Refunded(uint256 indexed id, address indexed agent, uint256 amount);
    error Invalid(); error Unauthorized(); error WrongState(); error TooEarly(); error TransferFailed();
    modifier guarded() { if (entered != 1) revert WrongState(); entered = 2; _; entered = 1; }

    constructor(address ape, address feeTreasury, address registry) {
        if (registry.code.length == 0 || registry == ape || registry == address(this)) revert Invalid();
        if (ape.code.length == 0 || feeTreasury == address(0) || feeTreasury == address(this)) revert Invalid();
        token = IApeToken(ape); treasury = feeTreasury; eligibilityRegistry = IForgeJobEligibility(registry);
    }
    function feeFor(uint256 reward) public pure returns (uint256) {
        // 5%, rounded up in raw token units, without multiplication overflow.
        return reward / 20 + (reward % 20 == 0 ? 0 : 1);
    }
    function getJob(uint256 id) external view returns (Job memory, Terms memory) {
        if (jobs[id].state == State.Missing) revert Invalid();
        return (jobs[id], terms[id]);
    }
    function post(Terms calldata t, uint256 reward, uint256 workerCollateral, uint64 listingSeconds, uint64 deliverySeconds, uint8 skill)
        external guarded returns (uint256 id)
    {
        if (reward == 0 || workerCollateral == 0 || workerCollateral > reward || listingSeconds < 1 days || listingSeconds > 30 days ||
            deliverySeconds < 1 days || deliverySeconds > 30 days || skill > 2 ||
            bytes(t.agentId).length == 0 || bytes(t.agentId).length > 64 ||
            bytes(t.title).length == 0 || bytes(t.title).length > 120 ||
            bytes(t.brief).length == 0 || bytes(t.brief).length > 2000 ||
            bytes(t.acceptance).length == 0 || bytes(t.acceptance).length > 1000 ||
            bytes(t.category).length == 0 || bytes(t.category).length > 32 ||
            bytes(t.contact).length < 9 || bytes(t.contact).length > 240 ||
            bytes(t.requiredSystems).length > 500 || bytes(t.requiredKnowledge).length > 500 ||
            bytes(t.visual).length > 240 || t.estimatedMinutes == 0 || t.estimatedMinutes > 43200) revert Invalid();
        bytes memory contact = bytes(t.contact);
        if (contact[0] != 'h' || contact[1] != 't' || contact[2] != 't' || contact[3] != 'p' ||
            contact[4] != 's' || contact[5] != ':' || contact[6] != '/' || contact[7] != '/') revert Invalid();
        if (!eligibilityRegistry.canPostJobs(msg.sender, keccak256(bytes(t.agentId)))) revert Unauthorized();
        uint256 fee = feeFor(reward);
        uint256 beforeBalance = token.balanceOf(address(this));
        _call(abi.encodeCall(IApeToken.transferFrom, (msg.sender, address(this), reward + fee)));
        if (token.balanceOf(address(this)) != beforeBalance + reward + fee) revert TransferFailed();
        // Fee destination's exact delta is verified as well. No taxed token acceptance.
        uint256 treasuryBefore = token.balanceOf(treasury);
        _call(abi.encodeCall(IApeToken.transfer, (treasury, fee)));
        if (token.balanceOf(address(this)) != beforeBalance + reward ||
            token.balanceOf(treasury) != treasuryBefore + fee) revert TransferFailed();
        id = nextJobId++;
        bytes32 hash = keccak256(abi.encode(t, reward, workerCollateral, listingSeconds, deliverySeconds, skill));
        Job storage j = jobs[id];
        j.agent = msg.sender; j.reward = reward; j.workerCollateral = workerCollateral;
        j.listingEnds = uint64(block.timestamp + listingSeconds); j.deliverySeconds = deliverySeconds;
        j.skill = skill; j.state = State.Open; j.termsHash = hash;
        terms[id] = t;
        escrowed += reward;
        emit Posted(id, msg.sender, reward, fee, hash);
    }
    function nominate(uint256 id, address worker) external guarded {
        Job storage j = jobs[id];
        if (msg.sender != j.agent) revert Unauthorized();
        if (j.state != State.Open || block.timestamp >= j.listingEnds) revert WrongState();
        if (worker == address(0) || worker == j.agent || worker == address(this)) revert Invalid();
        j.nominee = worker; emit Nominated(id, worker);
    }
    function accept(uint256 id) external guarded {
        Job storage j = jobs[id];
        if (msg.sender != j.nominee || msg.sender == address(0)) revert Unauthorized();
        if (j.state != State.Open || block.timestamp >= j.listingEnds) revert WrongState();
        uint256 beforeBalance = token.balanceOf(address(this));
        _call(abi.encodeCall(IApeToken.transferFrom, (msg.sender, address(this), j.workerCollateral)));
        if (token.balanceOf(address(this)) != beforeBalance + j.workerCollateral) revert TransferFailed();
        j.lockedCollateral = j.workerCollateral; bonded += j.workerCollateral;
        j.worker = msg.sender; j.state = State.Assigned;
        j.deliveryEnds = uint64(block.timestamp + j.deliverySeconds);
        emit Accepted(id, msg.sender, j.deliveryEnds);
        emit CollateralLocked(id, msg.sender, j.workerCollateral);
    }
    function submit(uint256 id, bytes32 evidenceHash) external guarded {
        Job storage j = jobs[id];
        if (msg.sender != j.worker) revert Unauthorized();
        if (j.state != State.Assigned || block.timestamp >= j.deliveryEnds) revert WrongState();
        if (evidenceHash == bytes32(0)) revert Invalid();
        j.evidenceHash = evidenceHash; j.reviewEnds = uint64(block.timestamp + REVIEW_SECONDS); j.state = State.Submitted;
        // On-time evidence returns the bond regardless of subjective approval.
        uint256 amount = j.lockedCollateral; j.lockedCollateral = 0; bonded -= amount;
        _transferExact(j.worker, amount); emit CollateralReturned(id, j.worker, amount);
        emit Submitted(id, evidenceHash, j.reviewEnds);
    }
    function approve(uint256 id) external guarded {
        Job storage j = jobs[id];
        if (msg.sender != j.agent) revert Unauthorized();
        if (j.state != State.Submitted || block.timestamp >= j.reviewEnds) revert WrongState();
        _pay(id, j, false);
    }
    function reject(uint256 id, bytes32 reasonHash) external guarded {
        Job storage j = jobs[id];
        if (msg.sender != j.agent) revert Unauthorized();
        if (j.state != State.Submitted || block.timestamp >= j.reviewEnds) revert WrongState();
        if (reasonHash == bytes32(0)) revert Invalid();
        j.state = State.Rejected; j.rejectionHash = reasonHash; emit Rejected(id, reasonHash);
    }
    /// @notice Anyone may trigger an earned timeout payout; recipient cannot be changed.
    function settleTimeout(uint256 id) external guarded {
        Job storage j = jobs[id];
        if (!autoPayOnTimeout || j.state != State.Submitted) revert WrongState();
        if (block.timestamp < j.reviewEnds) revert TooEarly();
        _pay(id, j, true);
    }
    /// @notice No clock-triggered transfer: anyone may settle missed delivery after its deadline.
    /// The job remains assigned until the listing-end-gated reward refund, preventing relocking.
    function settleMissedDelivery(uint256 id) external guarded {
        Job storage j = jobs[id];
        if (j.state != State.Assigned || j.lockedCollateral == 0) revert WrongState();
        if (block.timestamp < j.deliveryEnds) revert TooEarly();
        _forfeit(id, j);
    }
    function _forfeit(uint256 id, Job storage j) private {
        uint256 amount = j.lockedCollateral; j.lockedCollateral = 0; bonded -= amount;
        _transferExact(treasury, amount); emit CollateralForfeited(id, treasury, amount);
    }
    function refund(uint256 id) external guarded {
        Job storage j = jobs[id];
        if (msg.sender != j.agent) revert Unauthorized();
        if (block.timestamp < j.listingEnds) revert TooEarly();
        bool refundable = j.state == State.Open || j.state == State.Rejected ||
            (j.state == State.Assigned && block.timestamp >= j.deliveryEnds) ||
            (j.state == State.Submitted && !autoPayOnTimeout && block.timestamp >= j.reviewEnds);
        if (!refundable) revert WrongState();
        if (j.lockedCollateral != 0) _forfeit(id, j);
        j.state = State.Refunded; escrowed -= j.reward;
        _transferExact(j.agent, j.reward); emit Refunded(id, j.agent, j.reward);
    }
    function _pay(uint256 id, Job storage j, bool timedOut) private {
        j.state = State.Paid; escrowed -= j.reward;
        _transferExact(j.worker, j.reward); emit Paid(id, j.worker, j.reward, timedOut);
    }
    function _transferExact(address recipient, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        _call(abi.encodeCall(IApeToken.transfer, (recipient, amount)));
        if (token.balanceOf(address(this)) != beforeBalance - amount ||
            token.balanceOf(recipient) != recipientBefore + amount ||
            token.balanceOf(address(this)) < escrowed + bonded) revert TransferFailed();
    }
    function _call(bytes memory data) private {
        (bool ok, bytes memory result) = address(token).call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert TransferFailed();
    }
}
