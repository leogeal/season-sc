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

describe("SEASON invariants WITH rebalances (non-1:1 deterministic rates)", function () {
  let owner, u1, u2, u3;
  let spring, summer, autumn, winter, tokens;
  let vault, season, dex, rebal;

  this.timeout(90_000);

  function bn(x) { return ethers.BigNumber.from(x); }

  async function bal4(addr) {
    return Promise.all(tokens.map(t => t.balanceOf(addr)));
  }

  async function totalsPerToken(addresses) {
    const totals = [bn(0), bn(0), bn(0), bn(0)];
    for (const a of addresses) {
      const bals = await bal4(a);
      for (let i = 0; i < 4; i++) totals[i] = totals[i].add(bals[i]);
    }
    return totals;
  }

  function sumUnits(bals) {
    return bals.reduce((a, b) => a.add(b), bn(0));
  }

  // value = sum_i bal[i] * price[i] / 1e18
  function valueOf(bals, pricesE18) {
    let v = bn(0);
    for (let i = 0; i < 4; i++) {
      v = v.add(bals[i].mul(pricesE18[i]).div(bn("1000000000000000000")));
    }
    return v;
  }

  async function approveBig(signer) {
    const big = ethers.utils.parseUnits("1000000000", 18);
    for (let i = 0; i < 4; i++) {
      await tokens[i].connect(signer).approve(season.address, big);
    }
  }

  function entitlementPerToken(vaultBals, feeShares, totalSupply) {
    if (totalSupply.isZero()) return vaultBals.map(() => bn(0));
    return vaultBals.map(b => b.mul(feeShares).div(totalSupply));
  }

  // Prices in "USD" units (e18). Choose non-1:1 and nicely separated.
  // token0: $1.00, token1: $2.00, token2: $0.50, token3: $4.00
  const PRICES = [
    bn("1000000000000000000"),  // 1.0
    bn("2000000000000000000"),  // 2.0
    bn("500000000000000000"),   // 0.5
    bn("4000000000000000000"),  // 4.0
  ];

  // Fair deterministic rate: amountOut = amountIn * priceIn / priceOut
  function fairRateE18(priceIn, priceOut) {
    return priceIn.mul(bn("1000000000000000000")).div(priceOut);
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

    // Set internally consistent non-1:1 rates from PRICES
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        const r = fairRateE18(PRICES[i], PRICES[j]);
        await dex.setRateE18(tokens[i].address, tokens[j].address, r);
      }
    }

    // Fund DEX liquidity (no more minting after this)
    const dexLiq = ethers.utils.parseUnits("5000000", 18);
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(dex.address, dexLiq);
    }

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);

    await vault.connect(owner).transferOwnership(season.address);

    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);

    // Equal UNIT weights (this is intentionally "unit-based", not value-based)
    await rebal.connect(owner).setWeights([2500, 2500, 2500, 2500]);

    await rebal.connect(owner).transferOwnership(season.address);

    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);

    // Default: fees off; fees-on test will enable later
    await season.connect(owner).setFees(0, 0);

    // Let rebalances happen (no gating)
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMinDriftBps(0);
    await season.connect(owner).setRebalanceMaxTradeBps(10000);
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(0);
    await season.connect(owner).setRebalanceMinTradeAmount(0);

    // Pre-fund users so we never mint during the test run
    const userFloat = ethers.utils.parseUnits("8000", 18);
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(u1.address, userFloat);
      await tokens[i].mint(u2.address, userFloat);
      await tokens[i].mint(u3.address, userFloat);
    }

    await approveBig(u1);
    await approveBig(u2);
    await approveBig(u3);

    // Seed vault with skewed UNIT composition (rebalance will swap non-1:1 amounts)
    const seed = [
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("250", 18),
      ethers.utils.parseUnits("2000", 18),
      ethers.utils.parseUnits("50", 18),
    ];
    await season.connect(u1).mintWithDeposit(seed);
  });

  it("Invariant: per-token conservation across Vault + DEX + users under mixed mint/burn/rebalance (non-1:1)", async function () {
    const addresses = [
      vault.address,
      dex.address,
      u1.address,
      u2.address,
      u3.address,
      season.address,
      rebal.address,
      owner.address,
    ];

    const baseline = await totalsPerToken(addresses);

    // Also demonstrate: vault UNIT sum can change, but value stays ~constant across a rebalance
    const vb0 = await vault.balances();
    const units0 = sumUnits(vb0);
    const val0 = valueOf(vb0, PRICES);

    await season.connect(owner).rebalance();

    const vb1 = await vault.balances();
    const units1 = sumUnits(vb1);
    const val1 = valueOf(vb1, PRICES);

    // Units very likely change under non-1:1 swaps (not guaranteed in *every* state, but should here)
    expect(units1).to.not.equal(units0);

    // Value should be conserved (fair rates, no slippage) up to tiny rounding
    const valDust = bn(10_000); // in "value wei" (very small). Tune if needed.
    expect(val1.sub(val0).abs()).to.be.lte(valDust);

    // Now fuzz mixed ops
    const rng = xorshift32(0xA11CE);
    const STEPS = 55;

    for (let step = 0; step < STEPS; step++) {
      const r = rng() % 100;

      if (r < 45) {
        const actor = (rng() % 2 === 0) ? u2 : u3;
        const bals = await bal4(actor.address);

        const max = [];
        for (let i = 0; i < 4; i++) {
          const whole = randInt(rng, 1, 50);
          const want = ethers.utils.parseUnits(String(whole), 18);
          max.push(want.lte(bals[i]) ? want : bals[i]);
        }
        if (max.some(x => x.isZero())) continue;

        try {
          await season.connect(actor).mintWithDeposit(max);
        } catch (_) {
          continue;
        }
      } else if (r < 85) {
        const actor = (rng() % 2 === 0) ? u2 : u3;
        const shares = await season.balanceOf(actor.address);
        if (shares.isZero()) continue;

        const frac = randInt(rng, 5, 50);
        const amt = shares.mul(frac).div(100);
        if (amt.isZero()) continue;

        await season.connect(actor).burnToRedeem(amt);
      } else {
        await season.connect(owner).rebalance();
      }

      // Exact per-token conservation across the whole system
      const nowTotals = await totalsPerToken(addresses);
      for (let i = 0; i < 4; i++) {
        expect(nowTotals[i]).to.equal(baseline[i]);
      }
    }
  });

  it("Invariant: immediate mint->burn round-trip returns same underlying (± rounding dust) even after many rebalances (non-1:1)", async function () {
    const rng = xorshift32(0xBEEF1234);
    const CHURN = 22;

    for (let k = 0; k < CHURN; k++) {
      if ((rng() % 3) === 0) await season.connect(owner).rebalance();

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

    // Fresh round-trip
    const actor = u2;

    const deposit = [
      ethers.utils.parseUnits("37", 18),
      ethers.utils.parseUnits("19", 18),
      ethers.utils.parseUnits("23", 18),
      ethers.utils.parseUnits("11", 18),
    ];

    const userBefore = await bal4(actor.address);
    for (let i = 0; i < 4; i++) {
      expect(userBefore[i]).to.be.gte(deposit[i]);
    }

    const sharesBefore = await season.balanceOf(actor.address);

    await season.connect(actor).mintWithDeposit(deposit);

    const sharesAfter = await season.balanceOf(actor.address);
    const mintedShares = sharesAfter.sub(sharesBefore);
    expect(mintedShares).to.be.gt(0);

    await season.connect(actor).burnToRedeem(mintedShares);

    const userAfter = await bal4(actor.address);

    const dust = bn(40);
    for (let i = 0; i < 4; i++) {
      const diff = userAfter[i].sub(userBefore[i]).abs();
      expect(diff).to.be.lte(dust);
    }
  });

  it("Invariant (fees on): conservation holds; mint->burn cannot profit; fee-recipient claim explains loss (± dust) under non-1:1", async function () {
    // Enable share fees
    const entryBps = 50;
    const exitBps  = 50;
    await season.connect(owner).setFees(entryBps, exitBps);

    const addresses = [
      vault.address,
      dex.address,
      u1.address,
      u2.address,
      u3.address,
      season.address,
      rebal.address,
      owner.address, // fee recipient in your deploys
    ];

    const baseline = await totalsPerToken(addresses);

    const rng = xorshift32(0xFEEDBEEF);
    const STEPS = 45;

    for (let step = 0; step < STEPS; step++) {
      const r = rng() % 100;

      if (r < 45) {
        const actor = (rng() % 2 === 0) ? u2 : u3;
        const bals = await bal4(actor.address);

        const max = [];
        for (let i = 0; i < 4; i++) {
          const whole = randInt(rng, 1, 40);
          const want = ethers.utils.parseUnits(String(whole), 18);
          max.push(want.lte(bals[i]) ? want : bals[i]);
        }
        if (max.some(x => x.isZero())) continue;

        try { await season.connect(actor).mintWithDeposit(max); } catch (_) { continue; }

      } else if (r < 85) {
        const actor = (rng() % 2 === 0) ? u2 : u3;
        const shares = await season.balanceOf(actor.address);
        if (shares.isZero()) continue;

        const frac = randInt(rng, 5, 40);
        const amt = shares.mul(frac).div(100);
        if (amt.isZero()) continue;

        await season.connect(actor).burnToRedeem(amt);

      } else {
        await season.connect(owner).rebalance();
      }

      const nowTotals = await totalsPerToken(addresses);
      for (let i = 0; i < 4; i++) {
        expect(nowTotals[i]).to.equal(baseline[i]);
      }
    }

    // Fees-aware round-trip and fee-claim accounting
    const actor = u2;

    const userBefore = await bal4(actor.address);

    const feeSharesBefore = await season.balanceOf(owner.address);
    const supplyBefore = await season.totalSupply();
    const vaultBefore = await vault.balances();
    const feeEntBefore = entitlementPerToken(vaultBefore, feeSharesBefore, supplyBefore);

    const deposit = [
      ethers.utils.parseUnits("37", 18),
      ethers.utils.parseUnits("19", 18),
      ethers.utils.parseUnits("23", 18),
      ethers.utils.parseUnits("11", 18),
    ];

    const s0 = await season.balanceOf(actor.address);
    await season.connect(actor).mintWithDeposit(deposit);
    const s1 = await season.balanceOf(actor.address);
    const mintedNet = s1.sub(s0);
    expect(mintedNet).to.be.gt(0);

    await season.connect(actor).burnToRedeem(mintedNet);

    const userAfter = await bal4(actor.address);

    // No-profit (underlying) with slack
    const dust = bn(60);
    let anyLoss = false;
    for (let i = 0; i < 4; i++) {
      expect(userAfter[i]).to.be.lte(userBefore[i].add(dust));
      if (userAfter[i].add(dust).lt(userBefore[i])) anyLoss = true;
    }
    expect(anyLoss).to.equal(true);

    // Fee recipient pro-rata claim explains loss (± rounding)
    const feeSharesAfter = await season.balanceOf(owner.address);
    const supplyAfter = await season.totalSupply();
    const vaultAfter = await vault.balances();
    const feeEntAfter = entitlementPerToken(vaultAfter, feeSharesAfter, supplyAfter);

    const explainDust = bn(300);
    for (let i = 0; i < 4; i++) {
      const userLoss = userBefore[i].sub(userAfter[i]);
      const feeGain = feeEntAfter[i].sub(feeEntBefore[i]);
      const diff = userLoss.sub(feeGain).abs();
      expect(diff).to.be.lte(explainDust);
    }
  });
});
