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
  let wrappedNative;
  let vault, season, dex, rebal, oracle;

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

  function entitlementPerToken(vaultBals, feeShares, totalSupply) {
    if (totalSupply.isZero()) return vaultBals.map(() => bn(0));
    return vaultBals.map(b => b.mul(feeShares).div(totalSupply));
  }

  // Prices in "USD" units (e18). Choose non-1:1 and nicely separated.
  // Must match the oracle prices used in beforeEach: [4,2,1,0.5]
  const PRICES = [
    bn("4000000000000000000"),  // 4.0
    bn("2000000000000000000"),  // 2.0
    bn("1000000000000000000"),  // 1.0
    bn("500000000000000000"),   // 0.5
  ];

  // Fair deterministic rate: amountOut = amountIn * priceIn / priceOut
  function fairRateE18(priceIn, priceOut) {
    return priceIn.mul(bn("1000000000000000000")).div(priceOut);
  }

  beforeEach(async function () {
    [owner, u1, u2, u3] = await ethers.getSigners();

    const P = (x) => ethers.utils.parseUnits(String(x), 18);

    // Tokens
    const Mock = await ethers.getContractFactory("MockERC20");
    spring = await Mock.deploy("SPRING", "SPR");
    summer = await Mock.deploy("SUMMER", "SUM");
    autumn = await Mock.deploy("AUTUMN", "AUT");
    winter = await Mock.deploy("WINTER", "WIN");
    wrappedNative = await Mock.deploy("WrappedNative", "WN");   // 5th token (WETH/WPOL)
    tokens = [spring, summer, autumn, winter, wrappedNative];

    // Give u2/u3 inventories so fuzz mint/burn can run, and approve once.
    const Max = ethers.constants.MaxUint256;
    const userFloat = P(100000); // plenty
    for (const actor of [u1, u2, u3]) {
      for (let i = 0; i < 4; i++) {
	await tokens[i].mint(actor.address, userFloat);
      }
    }

    // Vault
    const Vault = await ethers.getContractFactory("SeasonVault");
    vault = await Vault.deploy(
      [spring.address, summer.address, autumn.address, winter.address,
       wrappedNative.address],
      owner.address
    );

    // DEX
    const Dex = await ethers.getContractFactory("MockDex");
    dex = await Dex.deploy(owner.address);

    // Oracle
    const Oracle = await ethers.getContractFactory("MockOracle");
    oracle = await Oracle.deploy();

    // Deterministic non-1:1 "fair" prices (expensive->cheap yields more raw units)
    const prices = [P(4), P(2), P(1), P(0.5)];
    await oracle.setPriceE18(spring.address, prices[0]);
    await oracle.setPriceE18(summer.address, prices[1]);
    await oracle.setPriceE18(autumn.address, prices[2]);
    await oracle.setPriceE18(winter.address, prices[3]);

    // Rates consistent with prices: rate(in->out)=priceIn/priceOut
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
	if (i === j) continue;
	const r = prices[i].mul(ethers.constants.WeiPerEther).div(prices[j]);
	await dex.setRateE18(tokens[i].address, tokens[j].address, r);
      }
    }

    // Fund DEX so swaps can pay out
    const big = P(1_000_000);
    for (let i = 0; i < 4; i++) await tokens[i].mint(dex.address, big);

    // SEASON + ownership
    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);
    for (const actor of [u1, u2, u3]) {
      for (let i = 0; i < 4; i++) {
	await tokens[i].connect(actor).approve(season.address, Max);
      }
    }
    await vault.connect(owner).transferOwnership(season.address);

    // Rebalancer (owned by SEASON)
    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);
    await rebal.connect(owner).transferOwnership(season.address);

    // Hook
    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);

    // Configure rebalancer
    await season.connect(owner).setRebalanceOracle(oracle.address);
    await season.connect(owner).setRebalanceMinUnitGainBps(1);
    await season.connect(owner).setRebalanceMinSpreadBps(0);
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMaxTradeBps(1000);
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(1);
    await season.connect(owner).setRebalanceMinTradeAmount(0);

    // Prevent VAULT_EMPTY_COMPONENT after many rebalances
    await season.connect(owner).setRebalanceMinComponentBalance(P(1));

    // Fees off (this file is non-1:1 accounting)
    await season.connect(owner).setFees(0, 0);

    // Seed vault so rebalances can execute during the invariant
    const dep = [P(1000), P(50), P(50), P(50)];
    await season.connect(u1).mintWithDeposit(dep);

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

    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    // count swaps from rebalancer logs
    const iface = rebal.interface;
    const parsed = rcpt.logs
      .filter((l) => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
      .filter(Boolean);

    const swapCount = parsed.filter((e) => e.name === "SwapExecuted").length;

    const vb1 = await vault.balances();
    const units1 = sumUnits(vb1);
    const val1 = valueOf(vb1, PRICES);

    // If we swapped expensive->cheap, raw units should strictly increase.
    // If we skipped, units should be unchanged.
    if (swapCount > 0) {
      expect(units1).to.be.gt(units0);
    } else {
      expect(units1).to.equal(units0);
    }
    // Value should be conserved (fair rates, no slippage) up to tiny rounding
    const valDust = bn(1_000_000); // 1e6 wei
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

  // Compute net redeemed amounts (what user got back from the vault)
  // netRedeemed[i] = userAfter[i] - (userBefore[i] - deposit[i])
  const netRedeemed = [];
  for (let i = 0; i < 4; i++) {
    netRedeemed.push(userAfter[i].add(deposit[i]).sub(userBefore[i]));
  }

  // Value of redeemed should match value of deposit up to rounding dust (fair rates)
  const depVal = valueOf(deposit, PRICES);
  const outVal = valueOf(netRedeemed, PRICES);

  const valDust = bn("1000000000000"); // 1e12 "value wei" (tiny but safe)
  expect(outVal.sub(depVal).abs()).to.be.lte(valDust);
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

    // Value-based no-profit (composition may change)
    const vBefore = valueOf(userBefore, PRICES);
    const vAfter  = valueOf(userAfter, PRICES);

    // user cannot profit in value; allow small rounding slack
    const valDust = bn("1000000000000"); // 1e12 value-wei
    expect(vAfter).to.be.lte(vBefore.add(valDust));

    // Fees should cause a real loss in value (beyond dust) most of the time
    expect(vBefore.sub(vAfter)).to.be.gt(bn(0));

    // Fee recipient pro-rata claim explains loss (± rounding)
    const feeSharesAfter = await season.balanceOf(owner.address);
    const supplyAfter = await season.totalSupply();
    const vaultAfter = await vault.balances();
    const feeEntAfter = entitlementPerToken(vaultAfter, feeSharesAfter, supplyAfter);

    const feeValBefore = valueOf(feeEntBefore, PRICES);
    const feeValAfter  = valueOf(feeEntAfter, PRICES);

    const userLossVal = vBefore.sub(vAfter);
    const feeGainVal  = feeValAfter.sub(feeValBefore);

    const explainDustVal = bn("5000000000000"); // 5e12 value-wei
    expect(userLossVal.sub(feeGainVal).abs()).to.be.lte(explainDustVal);
  });
});
