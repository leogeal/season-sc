const { expect } = require("chai");
const { ethers } = require("hardhat");

// ---------- deterministic RNG ----------
function xorshift32(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return x >>> 0;
  };
}
function randInt(rng, lo, hi) {
  const r = rng() % (hi - lo + 1);
  return lo + r;
}

describe("SEASON invariants WITH rebalances (conservation incl. DEX)", function () {
  let owner, u1, u2, u3;
  let spring, summer, autumn, winter, tokens;
  let vault, season, dex, rebal;

  // Bump if your machine is slow
  this.timeout(60_000);

  function bn(x) { return ethers.BigNumber.from(x); }

  async function bal4(addr) {
    return Promise.all(tokens.map(t => t.balanceOf(addr)));
  }

  async function totalsPerToken(addresses) {
    // returns array[4] of totals across all addresses for each token
    const totals = [bn(0), bn(0), bn(0), bn(0)];
    for (const a of addresses) {
      const bals = await bal4(a);
      for (let i = 0; i < 4; i++) totals[i] = totals[i].add(bals[i]);
    }
    return totals;
  }

  async function approveBig(signer) {
    const big = ethers.utils.parseUnits("1000000000", 18);
    for (let i = 0; i < 4; i++) {
      await tokens[i].connect(signer).approve(season.address, big);
    }
  }

  beforeEach(async function () {
    [owner, u1, u2, u3] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    spring = await Mock.deploy("SPRING", "SPR");
    summer = await Mock.deploy("SUMMER", "SUM");
    autumn = await Mock.deploy("AUTUMN", "AUT");
    winter = await Mock.deploy("WINTER", "WIN");
    tokens = [spring, summer, autumn, winter];

    const Vault = await ethers.getContractFactory("SeasonVault");
    vault = await Vault.deploy(
      [spring.address, summer.address, autumn.address, winter.address],
      owner.address
    );

    const Dex = await ethers.getContractFactory("MockDex");
    dex = await Dex.deploy(owner.address);

    // 1:1 rates for all pairs
    const ONE = ethers.utils.parseUnits("1", 18);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        await dex.setRateE18(tokens[i].address, tokens[j].address, ONE);
      }
    }

    // Fund DEX liquidity (no more minting after this)
    const dexLiq = ethers.utils.parseUnits("1000000", 18);
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(dex.address, dexLiq);
    }

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);

    // Vault owned by SEASON
    await vault.connect(owner).transferOwnership(season.address);

    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);

    // Set equal weights while EOA owns rebalancer
    await rebal.connect(owner).setWeights([2500, 2500, 2500, 2500]);

    // Transfer rebalancer ownership to SEASON so season.rebalance() can call it
    await rebal.connect(owner).transferOwnership(season.address);

    // Hook + authorize operator
    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);

    // Turn OFF fees for these invariants (strongest property)
    await season.connect(owner).setFees(0, 0);

    // Disable guardrails that could block rebalances (we want rebalances to happen)
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMinDriftBps(0);
    await season.connect(owner).setRebalanceMaxTradeBps(10000);
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(0);
    await season.connect(owner).setRebalanceMinTradeAmount(0);

    // Pre-fund users so we never mint during the test run
    const userFloat = ethers.utils.parseUnits("5000", 18);
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(u1.address, userFloat);
      await tokens[i].mint(u2.address, userFloat);
      await tokens[i].mint(u3.address, userFloat);
    }

    // Approve once
    await approveBig(u1);
    await approveBig(u2);
    await approveBig(u3);

    // Seed vault with an initial deposit (nontrivial composition)
    const seed = [
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("700", 18),
      ethers.utils.parseUnits("400", 18),
      ethers.utils.parseUnits("200", 18),
    ];
    await season.connect(u1).mintWithDeposit(seed);
  });

  it("Invariant: per-token conservation across Vault + DEX + users under mixed mint/burn/rebalance", async function () {
    const addresses = [
      vault.address,
      dex.address,
      u1.address,
      u2.address,
      u3.address,
      // these should usually be zero, but include defensively:
      season.address,
      rebal.address,
      owner.address,
    ];

    const baseline = await totalsPerToken(addresses);

    const rng = xorshift32(0xA11CE);
    const STEPS = 60;

    for (let step = 0; step < STEPS; step++) {
      const r = rng() % 100;

      if (r < 45) {
        // mintWithDeposit (u2 or u3)
        const actor = (rng() % 2 === 0) ? u2 : u3;
        const bals = await bal4(actor.address);

        // choose random amounts but ensure all > 0 and <= balance
        const max = [];
        for (let i = 0; i < 4; i++) {
          const whole = randInt(rng, 1, 50); // up to 50 tokens
          const want = ethers.utils.parseUnits(String(whole), 18);
          max.push(want.lte(bals[i]) ? want : bals[i]);
        }
        if (max.some(x => x.isZero())) continue;

        try {
          await season.connect(actor).mintWithDeposit(max);
        } catch (_) {
          // if deposit is rejected due to ratio constraints, just skip
          continue;
        }

      } else if (r < 85) {
        // burnToRedeem (u2 or u3)
        const actor = (rng() % 2 === 0) ? u2 : u3;
        const shares = await season.balanceOf(actor.address);
        if (shares.isZero()) continue;

        const frac = randInt(rng, 5, 50); // burn 5%..50%
        const amt = shares.mul(frac).div(100);
        if (amt.isZero()) continue;

        await season.connect(actor).burnToRedeem(amt);

      } else {
        // rebalance (owner-only)
        await season.connect(owner).rebalance();
      }

      // Per-token conservation check (exact, since we stopped minting after setup)
      const nowTotals = await totalsPerToken(addresses);
      for (let i = 0; i < 4; i++) {
        expect(nowTotals[i]).to.equal(baseline[i]);
      }
    }
  });

  it("Invariant: immediate mint->burn round-trip returns same underlying (± rounding dust) even after many rebalances", async function () {
    // churn state with random operations + rebalances
    const rng = xorshift32(0xBEEF1234);
    const CHURN = 25;

    for (let k = 0; k < CHURN; k++) {
      // do some rebalances
      if ((rng() % 3) === 0) await season.connect(owner).rebalance();

      // do some deposits/burns to move share supply around
      const actor = (rng() % 2 === 0) ? u2 : u3;
      const bals = await bal4(actor.address);
      const max = [];
      for (let i = 0; i < 4; i++) {
        const whole = randInt(rng, 1, 20);
        const want = ethers.utils.parseUnits(String(whole), 18);
        max.push(want.lte(bals[i]) ? want : bals[i]);
      }
      if (!max.some(x => x.isZero())) {
        try { await season.connect(actor).mintWithDeposit(max); } catch (_) {}
      }

      const shares = await season.balanceOf(actor.address);
      if (!shares.isZero() && (rng() % 2 === 0)) {
        const frac = randInt(rng, 10, 40);
        const amt = shares.mul(frac).div(100);
        if (!amt.isZero()) await season.connect(actor).burnToRedeem(amt);
      }
    }

    // Now do a strict round-trip test for a fresh action:
    const actor = u2;

    // Choose deposit amounts that are comfortably > 0 (avoid dust effects)
    const deposit = [
      ethers.utils.parseUnits("37", 18),
      ethers.utils.parseUnits("19", 18),
      ethers.utils.parseUnits("23", 18),
      ethers.utils.parseUnits("11", 18),
    ];

    // Ensure actor has enough (we pre-funded heavily, but clamp just in case)
    const balsBefore = await bal4(actor.address);
    for (let i = 0; i < 4; i++) {
      expect(balsBefore[i]).to.be.gte(deposit[i]);
    }

    const sharesBefore = await season.balanceOf(actor.address);

    await season.connect(actor).mintWithDeposit(deposit);

    const sharesAfter = await season.balanceOf(actor.address);
    const mintedShares = sharesAfter.sub(sharesBefore);
    expect(mintedShares).to.be.gt(0);

    // Burn exactly what was minted in this action
    await season.connect(actor).burnToRedeem(mintedShares);

    const balsAfter = await bal4(actor.address);

    // With fees=0 and immediate burn, should round-trip back to same balances (± tiny rounding dust).
    // This check is per-token and strict.
    const dust = bn(20); // allow up to 20 wei dust per token (tune if needed)
    for (let i = 0; i < 4; i++) {
      const diff = balsAfter[i].sub(balsBefore[i]).abs();
      expect(diff).to.be.lte(dust);
    }
  });
});
