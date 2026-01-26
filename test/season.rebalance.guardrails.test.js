const { expect } = require("chai");
const { ethers } = require("hardhat");

const P = (x) => ethers.utils.parseUnits(String(x), 18);

describe("SeasonRebalancer guardrails (max trade cap + cooldown)", function () {
  let owner, u1;
  let spring, summer, autumn, winter, tokens;
  let vault, season, dex, rebal;

  beforeEach(async function () {
    [owner, u1] = await ethers.getSigners();

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

    const prices = [P(4), P(2), P(1), P(0.5)];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
	if (i === j) continue;
	const r = prices[i].mul(ethers.constants.WeiPerEther).div(prices[j]); // priceIn/priceOut
	await dex.setRateE18(tokens[i].address, tokens[j].address, r);
      }
    }
    
    // Dex liquidity
    const big = ethers.utils.parseUnits("1000000", 18);
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(dex.address, big);
    }

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);
    await vault.connect(owner).transferOwnership(season.address);

    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);

    // Hand ownership to SEASON
    await rebal.connect(owner).transferOwnership(season.address);

    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);
    await season.connect(owner).setFees(0, 0);

    // --- Oracle + ranking prices ---
    const Oracle = await ethers.getContractFactory("MockOracle");
    oracle = await Oracle.deploy();

    await oracle.setPriceE18(spring.address, P(4));   // expensive
    await oracle.setPriceE18(summer.address, P(2));
    await oracle.setPriceE18(autumn.address, P(1));
    await oracle.setPriceE18(winter.address, P(0.5)); // cheap

    // --- Configure rebalancer via SEASON forwarders ---
    await season.connect(owner).setRebalanceOracle(oracle.address);
    await season.connect(owner).setRebalanceMinUnitGainBps(1);        // 0.01%
    await season.connect(owner).setRebalanceMinSpreadBps(0);          // allow
    await season.connect(owner).setRebalanceMinComponentBalance(P(1)); // IMPORTANT: keep each token >= 1

    // Keep your existing guardrail setters too:
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMaxTradeBps(1000);
    await season.connect(owner).setRebalanceMinTradeAmount(0);
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(1);

  });

  async function seedSkewedVault() {
    const dep = [P(1000), P(10), P(10), P(10)];
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(u1.address, dep[i]);
      await tokens[i].connect(u1).approve(season.address, dep[i]);
    }
    await season.connect(u1).mintWithDeposit(dep);
  }

  it("cooldown: prevents rapid-fire rebalances", async function () {
    await seedSkewedVault();

    await season.connect(owner).setRebalanceCooldownSeconds(3600);

    await season.connect(owner).rebalance();

    let threw = false;
    try {
      await season.connect(owner).rebalance();
    } catch (e) {
      threw = true;
      expect(e.message).to.include("CooldownActive()");
    }
    expect(threw).to.equal(true);

    // advance time
    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine");

    await season.connect(owner).rebalance(); // should succeed
  });

  it("maxTradeBps: caps total amountIn per token-in across swaps within a rebalance", async function () {
    await seedSkewedVault();

    // Set aggressive cap: 10% of each token's starting balance per rebalance
    await season.connect(owner).setRebalanceMaxTradeBps(1000); // 10%

    const before = await vault.balances();

    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    // Parse SwapExecuted events from rebalancer logs
    const iface = rebal.interface;
    const logs = rcpt.logs
      .filter(l => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map(l => {
        try { return iface.parseLog(l); } catch { return null; }
      })
      .filter(Boolean);

    const swaps = logs.filter(e => e.name === "SwapExecuted");
    expect(swaps.length).to.be.gte(1);

    // Build per-token caps from starting balances
    const capBps = 1000;
    const caps = before.map(b => b.mul(capBps).div(10000)); // floor

    // Aggregate amountIn by tokenIn
    const sumIn = new Map();
    for (const s of swaps) {
      const tokenIn = s.args.tokenIn.toLowerCase();
      const amtIn = s.args.amountIn;

      const prev = sumIn.get(tokenIn) || ethers.BigNumber.from(0);
      sumIn.set(tokenIn, prev.add(amtIn));
    }

    // Map token addresses -> index
    const addrToIndex = new Map();
    for (let i = 0; i < 4; i++) {
      addrToIndex.set(tokens[i].address.toLowerCase(), i);
    }

    // Check each tokenIn total <= cap[index]
    for (const [tokenIn, totalIn] of sumIn.entries()) {
      const idx = addrToIndex.get(tokenIn);
      expect(idx).to.not.equal(undefined);

      expect(totalIn).to.be.lte(caps[idx]);
    }
  });
});
