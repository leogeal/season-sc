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
  this.timeout(180_000); // 3 minutes
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

  function entitlementPerToken(vaultBals, feeShares, totalSupply) {
    // floor(vaultBal[i] * feeShares / totalSupply)
    if (totalSupply.isZero()) return vaultBals.map(() => ethers.BigNumber.from(0));
    return vaultBals.map(b => b.mul(feeShares).div(totalSupply));
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

    const Oracle = await ethers.getContractFactory("MockOracle");
    oracle = await Oracle.deploy();

    const P = (x) => ethers.utils.parseUnits(String(x), 18);
    await oracle.setPriceE18(spring.address, P(4));   // most expensive
    await oracle.setPriceE18(summer.address, P(2));
    await oracle.setPriceE18(autumn.address, P(1));
    await oracle.setPriceE18(winter.address, P(0.5)); // cheapest

    const prices = [P(4), P(2), P(1), P(0.5)];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
	if (i === j) continue;
	const r = prices[i].mul(ethers.constants.WeiPerEther).div(prices[j]);
	await dex.setRateE18(tokens[i].address, tokens[j].address, r);
      }
    }

    // Transfer rebalancer ownership to SEASON so season.rebalance() can call it
    await rebal.connect(owner).transferOwnership(season.address);

    // Hook + authorize operator
    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);
    await season.connect(owner).setRebalanceOracle(oracle.address);
    await season.connect(owner).setRebalanceMinUnitGainBps(0);  // 0.01% unit gain gate

    await season.connect(owner).setRebalanceMinSpreadBps(0);    // don’t block by spread
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMaxTradeBps(1000);
    await season.connect(owner).setRebalanceMinTradeAmount(0);
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(1);

    // Turn OFF fees for these invariants (strongest property)
    await season.connect(owner).setFees(0, 0);

    // Disable guardrails that could block rebalances (we want rebalances to happen)
    await season.connect(owner).setRebalanceMinDriftBps(0);
    await season.connect(owner).setRebalanceMaxTradeBps(10000);

    await season.connect(owner).setRebalanceMinComponentBalance(P(1));


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

  it("Invariant (fees on): conservation incl. DEX holds; mint->burn cannot profit; fee-recipient claim explains loss (± dust)", async function () {
    // Turn ON share fees (bps). Adjust as you like.
    const entryBps = 50; // 0.50%
    const exitBps  = 50; // 0.50%
    await season.connect(owner).setFees(entryBps, exitBps);

    const addresses = [
      vault.address,
      dex.address,
      u1.address,
      u2.address,
      u3.address,
      season.address,
      rebal.address,
      owner.address, // fee recipient in your deployments
    ];

    // Baseline conservation snapshot (no more underlying minting after beforeEach)
    const baseline = await totalsPerToken(addresses);

    // ---- Mixed ops + rebalances (same style as previous test) ----
    const rng = xorshift32(0xFEEDBEEF);
    const STEPS = 50;

    for (let step = 0; step < STEPS; step++) {
      const r = rng() % 100;

      if (r < 45) {
	// mintWithDeposit (u2/u3)
	const actor = (rng() % 2 === 0) ? u2 : u3;
	const bals = await bal4(actor.address);

	const max = [];
	for (let i = 0; i < 4; i++) {
	  const whole = randInt(rng, 1, 40);
	  const want = ethers.utils.parseUnits(String(whole), 18);
	  max.push(want.lte(bals[i]) ? want : bals[i]);
	}
	if (max.some(x => x.isZero())) continue;

	try {
	  await season.connect(actor).mintWithDeposit(max);
	} catch (_) {
	  // ratio / rounding rejections are ok in fuzz-y loop
	  continue;
	}
      } else if (r < 85) {
	// burnToRedeem (u2/u3)
	const actor = (rng() % 2 === 0) ? u2 : u3;
	const shares = await season.balanceOf(actor.address);
	if (shares.isZero()) continue;

	const frac = randInt(rng, 5, 40);
	const amt = shares.mul(frac).div(100);
	if (amt.isZero()) continue;

	await season.connect(actor).burnToRedeem(amt);
      } else {
	// rebalance (owner)
	await season.connect(owner).rebalance();
      }

      // Conservation (per-token) across vault+DEX+users+contracts must hold exactly
      const nowTotals = await totalsPerToken(addresses);
      for (let i = 0; i < 4; i++) {
	expect(nowTotals[i]).to.equal(baseline[i]);
      }
    }

    // ---- Fees-aware round-trip check (no profit + fee claim accounting) ----
    const actor = u2;

    // Snapshot actor underlying + fee-recipient share claim BEFORE round-trip
    const userBefore = await bal4(actor.address);

    const feeSharesBefore = await season.balanceOf(owner.address);
    const supplyBefore = await season.totalSupply();
    const vaultBefore = await vault.balances();
    const feeEntBefore = entitlementPerToken(vaultBefore, feeSharesBefore, supplyBefore);

    // Do a fresh deposit (non-dust) and burn back the *net minted shares*
    const deposit = [
      ethers.utils.parseUnits("37", 18),
      ethers.utils.parseUnits("19", 18),
      ethers.utils.parseUnits("23", 18),
      ethers.utils.parseUnits("11", 18),
    ];

    const shares0 = await season.balanceOf(actor.address);
    await season.connect(actor).mintWithDeposit(deposit);
    const shares1 = await season.balanceOf(actor.address);

    const mintedNet = shares1.sub(shares0);
    expect(mintedNet).to.be.gt(0);

    await season.connect(actor).burnToRedeem(mintedNet);

    const userAfter = await bal4(actor.address);

    // 1) No-profit: user cannot end up with more underlying than before (± dust)
    const dust = bn(40); // allow tiny rounding
    let anyLoss = false;
    for (let i = 0; i < 4; i++) {
      // userAfter[i] <= userBefore[i] + dust
      expect(userAfter[i]).to.be.lte(userBefore[i].add(dust));
      if (userAfter[i].add(dust).lt(userBefore[i])) anyLoss = true;
    }
    // With nonzero fees we expect some loss in typical cases
    expect(anyLoss).to.equal(true);

    // 2) Fee-recipient claim explains (most of) user loss:
    //    Δ feeEntitlement ≈ userLoss, within rounding dust
    const feeSharesAfter = await season.balanceOf(owner.address);
    const supplyAfter = await season.totalSupply();
    const vaultAfter = await vault.balances();
    const feeEntAfter = entitlementPerToken(vaultAfter, feeSharesAfter, supplyAfter);

    const explainDust = bn(200); // a bit looser because entitlement uses floor divisions
    for (let i = 0; i < 4; i++) {
      const userLoss = userBefore[i].sub(userAfter[i]); // should be >= 0 (ignoring dust)
      const feeGain = feeEntAfter[i].sub(feeEntBefore[i]); // should be >= 0

      // feeGain should be close to userLoss (allow rounding slack)
      const diff = userLoss.sub(feeGain).abs();
      expect(diff).to.be.lte(explainDust);
    }
  });

});
