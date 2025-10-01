import { describe, expect, it, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Proposal {
  proposer: string;
  startBlock: number;
  endBlock: number;
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  executed: boolean;
  cancelled: boolean;
  recipient?: string;
  amount?: number;
  proposalType: string;
  description: string;
  paramKey?: string;
  paramValue?: number;
}

interface Vote {
  vote: string;
}

interface ContractState {
  proposals: Map<number, Proposal>;
  votes: Map<string, Vote>; // Key is `${proposalId}-${voter}`
  params: Map<string, number>;
  proposalCount: number;
  totalSupplyAtLastProposal: number;
  blockHeight: number; // Mocked block height
  tokenBalances: Map<string, number>; // Mock ResToken balances
  tokenTotalSupply: number; // Mock total supply
  treasuryBalance: number; // Mock DAOTreasury balance
}

// Mock contract implementation
class GovernanceMock {
  private state: ContractState = {
    proposals: new Map(),
    votes: new Map(),
    params: new Map([
      ["quorum-percent", 20],
      ["voting-period", 144],
      ["proposal-delay", 10],
    ]),
    proposalCount: 0,
    totalSupplyAtLastProposal: 0,
    blockHeight: 1000, // Starting block
    tokenBalances: new Map(),
    tokenTotalSupply: 0,
    treasuryBalance: 0,
  };

  private ERR_PROPOSAL_EXISTS = 101;
  private ERR_PROPOSAL_NOT_FOUND = 102;
  private ERR_PROPOSAL_ENDED = 103;
  private ERR_PROPOSAL_ACTIVE = 104;
  private ERR_INSUFFICIENT_BALANCE = 105;
  private ERR_ALREADY_VOTED = 106;
  private ERR_VOTE_FAILED = 107;
  private ERR_QUORUM_NOT_MET = 108;
  private ERR_INVALID_PROPOSAL_TYPE = 109;
  private ERR_INVALID_AMOUNT = 110;
  private ERR_EXECUTION_FAILED = 111;
  private ERR_PROPOSAL_CANCELLED = 112;
  private ERR_NOT_PROPOSER = 113;
  private VOTE_THRESHOLD = 1000;
  private MAX_DESCRIPTION_LEN = 500;

  // Helper to advance block height
  advanceBlock(blocks: number): void {
    this.state.blockHeight += blocks;
  }

  // Mock ResToken calls
  private getBalance(account: string): ClarityResponse<number> {
    return { ok: true, value: this.state.tokenBalances.get(account) ?? 0 };
  }

  private getTotalSupply(): ClarityResponse<number> {
    return { ok: true, value: this.state.tokenTotalSupply };
  }

  // Mock DAOTreasury withdraw
  private withdraw(amount: number, recipient: string): ClarityResponse<boolean> {
    if (this.state.treasuryBalance < amount) {
      return { ok: false, value: this.ERR_EXECUTION_FAILED };
    }
    this.state.treasuryBalance -= amount;
    const recipientBalance = this.state.tokenBalances.get(recipient) ?? 0;
    this.state.tokenBalances.set(recipient, recipientBalance + amount);
    return { ok: true, value: true };
  }

  // Set mock balances for testing
  setTokenBalance(account: string, balance: number): void {
    this.state.tokenBalances.set(account, balance);
    this.state.tokenTotalSupply = Array.from(this.state.tokenBalances.values()).reduce((a, b) => a + b, 0);
  }

  setTreasuryBalance(balance: number): void {
    this.state.treasuryBalance = balance;
  }

  createProposal(
    proposer: string,
    recipient?: string,
    amount?: number,
    proposalType: string = "fund-distribution",
    description: string = "Test proposal",
    paramKey?: string,
    paramValue?: number
  ): ClarityResponse<number> {
    const id = this.state.proposalCount + 1;
    const balance = this.getBalance(proposer).value as number;
    const currentBlock = this.state.blockHeight;
    const delay = this.state.params.get("proposal-delay") ?? 10;
    const period = this.state.params.get("voting-period") ?? 144;
    const start = currentBlock + delay;
    const end = start + period;
    const totalSupply = this.getTotalSupply().value as number;

    if (balance < this.VOTE_THRESHOLD) {
      return { ok: false, value: this.ERR_INSUFFICIENT_BALANCE };
    }
    if (this.state.proposals.has(id)) {
      return { ok: false, value: this.ERR_PROPOSAL_EXISTS };
    }
    if (!["fund-distribution", "param-change", "upgrade"].includes(proposalType)) {
      return { ok: false, value: this.ERR_INVALID_PROPOSAL_TYPE };
    }
    if (description.length > this.MAX_DESCRIPTION_LEN) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (proposalType === "fund-distribution") {
      if (!recipient || !amount || amount <= 0) {
        return { ok: false, value: this.ERR_INVALID_AMOUNT };
      }
    } else if (proposalType === "param-change") {
      if (!paramKey || paramValue === undefined) {
        return { ok: false, value: this.ERR_INVALID_AMOUNT };
      }
    }

    this.state.proposals.set(id, {
      proposer,
      startBlock: start,
      endBlock: end,
      votesFor: 0,
      votesAgainst: 0,
      votesAbstain: 0,
      executed: false,
      cancelled: false,
      recipient,
      amount,
      proposalType,
      description,
      paramKey,
      paramValue,
    });
    this.state.proposalCount = id;
    this.state.totalSupplyAtLastProposal = totalSupply;
    return { ok: true, value: id };
  }

  vote(voter: string, proposalId: number, voteType: string): ClarityResponse<boolean> {
    const prop = this.state.proposals.get(proposalId);
    if (!prop) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_FOUND };
    }
    const balance = this.getBalance(voter).value as number;
    const currentBlock = this.state.blockHeight;
    const voteKey = `${proposalId}-${voter}`;
    const existingVote = this.state.votes.get(voteKey);

    if (existingVote) {
      return { ok: false, value: this.ERR_ALREADY_VOTED };
    }
    if (balance < this.VOTE_THRESHOLD) {
      return { ok: false, value: this.ERR_INSUFFICIENT_BALANCE };
    }
    if (currentBlock < prop.startBlock || currentBlock >= prop.endBlock) {
      return { ok: false, value: this.ERR_PROPOSAL_ENDED };
    }
    if (prop.cancelled) {
      return { ok: false, value: this.ERR_PROPOSAL_CANCELLED };
    }
    if (!["for", "against", "abstain"].includes(voteType)) {
      return { ok: false, value: this.ERR_VOTE_FAILED };
    }

    this.state.votes.set(voteKey, { vote: voteType });
    if (voteType === "for") {
      prop.votesFor += balance;
    } else if (voteType === "against") {
      prop.votesAgainst += balance;
    } else {
      prop.votesAbstain += balance;
    }
    this.state.proposals.set(proposalId, prop);
    return { ok: true, value: true };
  }

  executeProposal(_caller: string, proposalId: number): ClarityResponse<boolean> {
    const prop = this.state.proposals.get(proposalId);
    if (!prop) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_FOUND };
    }
    const currentBlock = this.state.blockHeight;
    const totalVotes = prop.votesFor + prop.votesAgainst + prop.votesAbstain;
    const quorumPercent = this.state.params.get("quorum-percent") ?? 20;
    const quorumRequired = (this.state.totalSupplyAtLastProposal * quorumPercent) / 100;

    if (currentBlock <= prop.endBlock) {
      return { ok: false, value: this.ERR_PROPOSAL_ACTIVE };
    }
    if (prop.executed) {
      return { ok: false, value: this.ERR_PROPOSAL_ENDED };
    }
    if (prop.cancelled) {
      return { ok: false, value: this.ERR_PROPOSAL_CANCELLED };
    }
    if (prop.votesFor <= prop.votesAgainst) {
      return { ok: false, value: this.ERR_VOTE_FAILED };
    }
    if (totalVotes < quorumRequired) {
      return { ok: false, value: this.ERR_QUORUM_NOT_MET };
    }

    if (prop.proposalType === "fund-distribution") {
      const withdrawResult = this.withdraw(prop.amount!, prop.recipient!);
      if (!withdrawResult.ok) {
        return withdrawResult;
      }
    } else if (prop.proposalType === "param-change") {
      this.state.params.set(prop.paramKey!, prop.paramValue!);
    }
    // For "upgrade", just mark executed

    prop.executed = true;
    this.state.proposals.set(proposalId, prop);
    return { ok: true, value: true };
  }

  cancelProposal(caller: string, proposalId: number): ClarityResponse<boolean> {
    const prop = this.state.proposals.get(proposalId);
    if (!prop) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_FOUND };
    }
    const currentBlock = this.state.blockHeight;

    if (prop.proposer !== caller) {
      return { ok: false, value: this.ERR_NOT_PROPOSER };
    }
    if (currentBlock >= prop.startBlock) {
      return { ok: false, value: this.ERR_PROPOSAL_ACTIVE };
    }
    if (prop.cancelled) {
      return { ok: false, value: this.ERR_PROPOSAL_CANCELLED };
    }

    prop.cancelled = true;
    this.state.proposals.set(proposalId, prop);
    return { ok: true, value: true };
  }

  getProposal(id: number): ClarityResponse<Proposal | undefined> {
    return { ok: true, value: this.state.proposals.get(id) };
  }

  getVote(proposalId: number, voter: string): ClarityResponse<Vote | undefined> {
    const voteKey = `${proposalId}-${voter}`;
    return { ok: true, value: this.state.votes.get(voteKey) };
  }

  getParam(key: string): ClarityResponse<number | undefined> {
    return { ok: true, value: this.state.params.get(key) };
  }

  getProposalCount(): ClarityResponse<number> {
    return { ok: true, value: this.state.proposalCount };
  }

  hasVoted(proposalId: number, voter: string): ClarityResponse<boolean> {
    const voteKey = `${proposalId}-${voter}`;
    return { ok: true, value: this.state.votes.has(voteKey) };
  }

  isProposalActive(id: number): ClarityResponse<boolean> {
    const prop = this.state.proposals.get(id);
    if (!prop) {
      return { ok: true, value: false };
    }
    const currentBlock = this.state.blockHeight;
    return {
      ok: true,
      value: currentBlock >= prop.startBlock && currentBlock < prop.endBlock && !prop.cancelled,
    };
  }

  calculateQuorum(proposalId: number): ClarityResponse<number | undefined> {
    const prop = this.state.proposals.get(proposalId);
    if (!prop) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_FOUND };
    }
    const totalVotes = prop.votesFor + prop.votesAgainst + prop.votesAbstain;
    return { ok: true, value: (totalVotes * 100) / this.state.totalSupplyAtLastProposal };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  proposer: "wallet_1",
  voter1: "wallet_2",
  voter2: "wallet_3",
  recipient: "wallet_4",
};

describe("Governance Contract", () => {
  let contract: GovernanceMock;

  beforeEach(() => {
    contract = new GovernanceMock();
    // Set initial balances
    contract.setTokenBalance(accounts.proposer, 2000);
    contract.setTokenBalance(accounts.voter1, 1500);
    contract.setTokenBalance(accounts.voter2, 1500);
    contract.setTreasuryBalance(10000);
  });

  it("should create a fund-distribution proposal", () => {
    const createResult = contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Distribute funds to researcher"
    );
    expect(createResult).toEqual({ ok: true, value: 1 });

    const proposal = contract.getProposal(1);
    expect(proposal).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          proposalType: "fund-distribution",
          amount: 500,
        }),
      })
    );
    expect(contract.getProposalCount()).toEqual({ ok: true, value: 1 });
  });

  it("should prevent proposal creation with insufficient balance", () => {
    contract.setTokenBalance(accounts.proposer, 500);
    const createResult = contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Low balance"
    );
    expect(createResult).toEqual({ ok: false, value: 105 });
  });

  it("should allow voting on active proposal", () => {
    contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Test vote"
    );
    contract.advanceBlock(11); // Past delay

    const voteResult = contract.vote(accounts.voter1, 1, "for");
    expect(voteResult).toEqual({ ok: true, value: true });

    const proposal = contract.getProposal(1);
    expect(proposal).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          votesFor: 1500,
        }),
      })
    );
    expect(contract.hasVoted(1, accounts.voter1)).toEqual({ ok: true, value: true });
  });

  it("should prevent double voting", () => {
    contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Double vote"
    );
    contract.advanceBlock(11);

    contract.vote(accounts.voter1, 1, "for");
    const secondVote = contract.vote(accounts.voter1, 1, "against");
    expect(secondVote).toEqual({ ok: false, value: 106 });
  });

  it("should execute proposal after voting period if quorum met", () => {
    contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Executable proposal"
    );
    contract.advanceBlock(11);

    contract.vote(accounts.voter1, 1, "for");
    contract.vote(accounts.voter2, 1, "for");
    contract.advanceBlock(145); // Past end

    const executeResult = contract.executeProposal(accounts.deployer, 1);
    expect(executeResult).toEqual({ ok: true, value: true });

    const proposal = contract.getProposal(1);
    expect(proposal).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          executed: true,
        }),
      })
    );
    expect(contract.getBalance(accounts.recipient)).toEqual({ ok: true, value: 500 });
  });

  it("should allow cancelling proposal before start", () => {
    contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Cancellable"
    );

    const cancelResult = contract.cancelProposal(accounts.proposer, 1);
    expect(cancelResult).toEqual({ ok: true, value: true });

    const proposal = contract.getProposal(1);
    expect(proposal).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          cancelled: true,
        }),
      })
    );
  });

  it("should prevent non-proposer from cancelling", () => {
    contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Non-cancellable"
    );

    const cancelResult = contract.cancelProposal(accounts.voter1, 1);
    expect(cancelResult).toEqual({ ok: false, value: 113 });
  });

  it("should create and execute param-change proposal", () => {
    contract.createProposal(
      accounts.proposer,
      undefined,
      undefined,
      "param-change",
      "Change quorum",
      "quorum-percent",
      25
    );
    contract.advanceBlock(11);

    contract.vote(accounts.voter1, 1, "for");
    contract.vote(accounts.voter2, 1, "for");
    contract.advanceBlock(145);

    const executeResult = contract.executeProposal(accounts.deployer, 1);
    expect(executeResult).toEqual({ ok: true, value: true });

    expect(contract.getParam("quorum-percent")).toEqual({ ok: true, value: 25 });
  });

  it("should prevent invalid proposal type", () => {
    const createResult = contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "invalid-type",
      "Invalid"
    );
    expect(createResult).toEqual({ ok: false, value: 109 });
  });

  it("should check if proposal is active", () => {
    contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Active check"
    );
    expect(contract.isProposalActive(1)).toEqual({ ok: true, value: false });

    contract.advanceBlock(11);
    expect(contract.isProposalActive(1)).toEqual({ ok: true, value: true });

    contract.advanceBlock(145);
    expect(contract.isProposalActive(1)).toEqual({ ok: true, value: false });
  });

  it("should calculate quorum correctly", () => {
    contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Quorum calc"
    );
    contract.advanceBlock(11);

    contract.vote(accounts.voter1, 1, "for");
    contract.vote(accounts.voter2, 1, "abstain");

    const quorum = contract.calculateQuorum(1);
    expect(quorum).toEqual({ ok: true, value: 60 }); // 3000 votes / 5000 total * 100 = 60%
  });

  it("should prevent voting on cancelled proposal", () => {
    contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Cancelled vote"
    );
    contract.cancelProposal(accounts.proposer, 1);
    contract.advanceBlock(11);

    const voteResult = contract.vote(accounts.voter1, 1, "for");
    expect(voteResult).toEqual({ ok: false, value: 112 });
  });

  it("should prevent execution on insufficient votes for", () => {
    contract.createProposal(
      accounts.proposer,
      accounts.recipient,
      500,
      "fund-distribution",
      "Insufficient for"
    );
    contract.advanceBlock(11);

    contract.vote(accounts.voter1, 1, "against");
    contract.vote(accounts.voter2, 1, "against");
    contract.advanceBlock(145);

    const executeResult = contract.executeProposal(accounts.deployer, 1);
    expect(executeResult).toEqual({ ok: false, value: 107 });
  });
});