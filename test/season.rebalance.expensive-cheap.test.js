const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SEASON rebalance: expensive -> cheap (raw unit objective)", function () {
  let owner, u1;
  let spring, summer, autumn, winter, tokens;
  let wrappedNative;
  let vault, season, dex, rebal, oracle;

  beforeEach(async function () {
    [owner, u1] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    spring = await Mock.deploy("SPRING", "SPR");
    summer = await Mock.deploy("SUMMER", "SUM");
    autumn = await Mock.deploy("AUTUMN", "AUT");
    winter = await Mock.deploy("WINTER", "WIN");
    wrappedNative = await Mock.deploy("WrappedNative", "WN");   // 5th token (WETH/WPOL)
    tokens = [spring, summer, autumn, winter, wrappedNative];

    const Vault = await ethers.getContractFactory("SeasonVault");
    vault = await Vault.deploy([spring.address, summer.address, autumn.address, winter.address, wrappedNative.address], owner.address);

    const Dex = await ethers.getContractFactory("MockDex");
    dex = await Dex.deploy(owner.address);

    const Oracle = await ethers.getContractFactory("MockOracle");
    oracle = await Oracle.deploy();

    // Prices (E18) for ranking: SPRING most expensive, WINTER cheapest
    const P = (x) => ethers.utils.parseUnits(String(x), 18);
    await oracle.setPriceE18(spring.address, P(4));
    await oracle.setPriceE18(summer.address, P(2));
    await oracle.setPriceE18(autumn.address, P(1));
    await oracle.setPriceE18(winter.address, P(0.5));

    // Fair deterministic rates: rate(in->out) = priceIn/priceOut
    const rate = async (tin, tout, pin, pout) => {
      const r = pin.mul(ethers.constants.WeiPerEther).div(pout);
      await dex.setRateE18(tin, tout, r);
    };
    const prices = [P(4), P(2), P(1), P(0.5)];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        await rate(tokens[i].address, tokens[j].address, prices[i], prices[j]);
      }
    }

    // Liquidity so DEX can pay outputs
    const big = ethers.utils.parseUnits("1000000", 18);
    for (let i = 0; i < 4; i++) await tokens[i].mint(dex.address, big);

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);

    await vault.connect(owner).transferOwnership(season.address);

    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);

    // transfer rebalancer ownership to SEASON
    await rebal.connect(owner).transferOwnership(season.address);

    // Hook
    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);

    // Configure rebalancer via SEASON
    await season.connect(owner).setRebalanceOracle(oracle.address);
    await season.connect(owner).setRebalanceMinUnitGainBps(1); // 0.01%
    await season.connect(owner).setRebalanceMinSpreadBps(0);

    // No fees to make the unit-growth clean
    await season.connect(owner).setFees(0, 0);
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMaxTradeBps(1000); // 10%
    await season.connect(owner).setRebalanceMinTradeAmount(0);
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(1);

    // Seed vault via mintWithDeposit (skewed toward SPRING, expensive)
    const dep = [
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("10", 18),
      ethers.utils.parseUnits("10", 18),
      ethers.utils.parseUnits("10", 18),
    ];
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(u1.address, dep[i]);
      await tokens[i].connect(u1).approve(season.address, dep[i]);
    }
    await season.connect(u1).mintWithDeposit(dep);
  });

  it("swaps most expensive into cheapest; raw unit sum increases", async function () {
    const before = await vault.balances();
    const sumBefore = before.reduce((a, b) => a.add(b), ethers.BigNumber.from(0));

    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    // parse SwapExecuted from rebalancer
    const iface = rebal.interface;
    const logs = rcpt.logs
      .filter(l => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .filter(Boolean);

    const swaps = logs.filter(e => e.name === "SwapExecuted");
    expect(swaps.length).to.equal(1);

    const s = swaps[0];
    expect(s.args.tokenIn).to.equal(spring.address);
    expect(s.args.tokenOut).to.equal(winter.address);
    expect(s.args.amountOut).to.be.gt(s.args.amountIn);

    const after = await vault.balances();
    const sumAfter = after.reduce((a, b) => a.add(b), ethers.BigNumber.from(0));
    expect(sumAfter).to.be.gt(sumBefore);
  });
});
