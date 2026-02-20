const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SeasonRebalancer event-level accounting", function () {
  let owner, u1;
  let spring, summer, autumn, winter, tokens;
  let wrappedNative;
  let vault, season, dex, rebal, oracle;

  beforeEach(async function () {
    [owner, u1] = await ethers.getSigners();

    // Helper FIRST (avoid TDZ errors)
    const P = (x) => ethers.utils.parseUnits(String(x), 18);

    // Tokens
    const Mock = await ethers.getContractFactory("MockERC20");
    spring = await Mock.deploy("SPRING", "SPR");
    summer = await Mock.deploy("SUMMER", "SUM");
    autumn = await Mock.deploy("AUTUMN", "AUT");
    winter = await Mock.deploy("WINTER", "WIN");
    wrappedNative = await Mock.deploy("WrappedNative", "WN");   // 5th token (WETH/WPOL)
    tokens = [spring, summer, autumn, winter, wrappedNative];

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

    // Oracle (for expensive/cheap ranking)
    const Oracle = await ethers.getContractFactory("MockOracle");
    oracle = await Oracle.deploy();

    // Prices: SPRING expensive, WINTER cheap
    const prices = [P(4), P(2), P(1), P(0.5)];
    await oracle.setPriceE18(spring.address, prices[0]);
    await oracle.setPriceE18(summer.address, prices[1]);
    await oracle.setPriceE18(autumn.address, prices[2]);
    await oracle.setPriceE18(winter.address, prices[3]);

    // Fair deterministic rates: rate(in->out) = priceIn/priceOut
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        const r = prices[i].mul(ethers.constants.WeiPerEther).div(prices[j]);
        await dex.setRateE18(tokens[i].address, tokens[j].address, r);
      }
    }

    // Fund DEX for outputs
    const big = P(1_000_000);
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(dex.address, big);
    }

    // SEASON
    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);

    // Vault owned by SEASON
    await vault.connect(owner).transferOwnership(season.address);

    // Rebalancer (owned by SEASON)
    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);
    await rebal.connect(owner).transferOwnership(season.address);

    // Hook rebalancer & vault operator
    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);

    // Configure rebalancer for expensive->cheap
    await season.connect(owner).setRebalanceOracle(oracle.address);
    await season.connect(owner).setRebalanceMinUnitGainBps(1);
    await season.connect(owner).setRebalanceMinSpreadBps(0);
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMaxTradeBps(1000);
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(1);
    await season.connect(owner).setRebalanceMinTradeAmount(0);

    // IMPORTANT: keep vault mintable (avoid VAULT_EMPTY_COMPONENT)
    await season.connect(owner).setRebalanceMinComponentBalance(P(1));

    // Seed vault with all components (skew SPRING so swap triggers)
    const dep = [P(1000), P(50), P(50), P(50)];
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(u1.address, dep[i]);
      await tokens[i].connect(u1).approve(season.address, dep[i]);
    }
    await season.connect(u1).mintWithDeposit(dep);

    // Fees off for clean event expectations
    await season.connect(owner).setFees(0, 0);
  });

  it("emits RebalanceStarted, SwapExecuted (>=1), and RebalanceFinished with a consistent nonce", async function () {
    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    const iface = rebal.interface;

    const parsed = rcpt.logs
      .filter((l) => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map((l) => {
        try { return iface.parseLog(l); } catch { return null; }
      })
      .filter(Boolean);

    const started = parsed.filter((e) => e.name === "RebalanceStarted");
    const swaps = parsed.filter((e) => e.name === "SwapExecuted");
    const finished = parsed.filter((e) => e.name === "RebalanceFinished");

    expect(started.length).to.equal(1);
    expect(swaps.length).to.be.gte(1);
    expect(finished.length).to.equal(1);

    const n0 = started[0].args.nonce;
    for (const e of swaps) expect(e.args.nonce).to.equal(n0);
    expect(finished[0].args.nonce).to.equal(n0);

    // Under this strategy/config, expect exactly one swap: SPRING -> WINTER
    expect(swaps.length).to.equal(1);
    expect(swaps[0].args.tokenIn).to.equal(spring.address);
    expect(swaps[0].args.tokenOut).to.equal(winter.address);
    expect(swaps[0].args.amountOut).to.be.gt(swaps[0].args.amountIn);
  });
});
