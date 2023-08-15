import { BigNumber, Contract, ethers } from "ethers";
import {
  ChainAccountData,
  ChainAccount,
  Chain,
  RpcsPerChain,
  SingleAssetUsageInfo,
  ReservesMapping,
} from "./types";
import { JsonRpcProvider } from "@ethersproject/providers";
import {
  V2_POOL_ABI,
  V2_POOL_PROVIDER_ABI,
  V3_POOL_PROVIDER_ABI,
  V3_POOl_ABI,
} from "./abis";
import { ChainId, UiPoolDataProvider } from "@aave/contract-helpers";
import * as markets from "@bgd-labs/aave-address-book";

const CHAIN_TO_RPC: RpcsPerChain = {
  [Chain.ETHEREUM]: "https://eth.llamarpc.com",
  [Chain.ETHEREUM_SEPOLIA]: "https://rpc.sepolia.org",
  [Chain.POLYGON]: "https://polygon.llamarpc.com",
  [Chain.POLYGON_MUMBAI]: "https://rpc.ankr.com/polygon_mumbai",
  [Chain.AVALANCHE]: "https://avalancherpc.com",
  [Chain.ARBITRUM]: "https://arb1.arbitrum.io/rpc",
  [Chain.OPTIMISM]: "https://mainnet.optimism.io",
  [Chain.METIS]: "https://andromeda.metis.io/?owner=1088",
};

function getAaveMarket(
  chain: Chain,
  aaveVersion: number
): [string, string, ChainId] {
  let market, chainId;
  switch (true) {
    case chain == Chain.ETHEREUM && aaveVersion == 2:
      market = markets.AaveV2Ethereum;
      chainId = ChainId.mainnet;
      break;
    case chain == Chain.ETHEREUM && aaveVersion == 3:
      market = markets.AaveV3Ethereum;
      chainId = ChainId.mainnet;
      break;
    case chain == Chain.ETHEREUM_SEPOLIA && aaveVersion == 3:
      market = markets.AaveV3Sepolia;
      chainId = ChainId.sepolia;
      break;
    case chain == Chain.POLYGON && aaveVersion == 2:
      market = markets.AaveV2Polygon;
      chainId = ChainId.polygon;
      break;
    case chain == Chain.POLYGON && aaveVersion == 3:
      market = markets.AaveV3Polygon;
      chainId = ChainId.polygon;
      break;
    case chain == Chain.POLYGON_MUMBAI && aaveVersion == 2:
      market = markets.AaveV2Mumbai;
      chainId = ChainId.mumbai;
      break;
    case chain == Chain.POLYGON_MUMBAI && aaveVersion == 3:
      market = markets.AaveV3Mumbai;
      chainId = ChainId.mumbai;
      break;
    case chain == Chain.AVALANCHE && aaveVersion == 2:
      market = markets.AaveV2Avalanche;
      chainId = ChainId.avalanche;
      break;
    case chain == Chain.AVALANCHE && aaveVersion == 3:
      market = markets.AaveV3Avalanche;
      chainId = ChainId.avalanche;
      break;
    case chain == Chain.ARBITRUM && aaveVersion == 3:
      market = markets.AaveV3Arbitrum;
      chainId = ChainId.arbitrum_one;
      break;
    case chain == Chain.OPTIMISM && aaveVersion == 3:
      market = markets.AaveV3Optimism;
      chainId = ChainId.optimism;
      break;
    case chain == Chain.METIS && aaveVersion == 3:
      market = markets.AaveV3Metis;
      chainId = ChainId.metis_andromeda;
      break;
  }
  return [
    market!.UI_POOL_DATA_PROVIDER,
    market!.POOL_ADDRESSES_PROVIDER,
    chainId!,
  ];
}

export async function queryAccountData(
  account: ChainAccount
): Promise<ChainAccountData> {
  const rpcUrl = CHAIN_TO_RPC[account.chain as keyof typeof CHAIN_TO_RPC];
  const provider = new JsonRpcProvider(rpcUrl);

  const [uiPoolDataProvider, poolAddressProvider, chainId] = getAaveMarket(
    account.chain,
    account.aaveVersion
  );

  let lendingPoolContract;
  if (account.aaveVersion == 2) {
    const addressProviderContract = new Contract(
      poolAddressProvider,
      V2_POOL_PROVIDER_ABI,
      provider
    );
    const lendingPoolAddress = await addressProviderContract.getLendingPool();
    lendingPoolContract = new Contract(
      lendingPoolAddress,
      V2_POOL_ABI,
      provider
    );
  } else {
    const addressProviderContract = new Contract(
      poolAddressProvider,
      V3_POOL_PROVIDER_ABI,
      provider
    );
    const lendingPoolAddress = await addressProviderContract.getPool();
    lendingPoolContract = new Contract(
      lendingPoolAddress,
      V3_POOl_ABI,
      provider
    );
  }
  const userAccountData = await lendingPoolContract.getUserAccountData(
    account.address
  );
  const healthFactorRaw: BigNumber =
    userAccountData[userAccountData.length - 1];

  let healthFactor: number;
  if (healthFactorRaw.eq(ethers.constants.MaxUint256)) {
    healthFactor = -1;
  } else {
    healthFactor = healthFactorRaw.div(BigNumber.from(10).pow(18)).toNumber();
  }

  const poolDataProviderContract = new UiPoolDataProvider({
    uiPoolDataProviderAddress: uiPoolDataProvider,
    provider,
    chainId: chainId,
  });
  const userReserves = await poolDataProviderContract.getUserReservesHumanized({
    lendingPoolAddressProvider: poolAddressProvider,
    user: account.address,
  });

  const reserves = await poolDataProviderContract.getReservesHumanized({
    lendingPoolAddressProvider: poolAddressProvider,
  });

  const marketCurrencyMultiplier =
    parseInt(reserves.baseCurrencyData.marketReferenceCurrencyPriceInUsd) /
    10 ** reserves.baseCurrencyData.marketReferenceCurrencyDecimals;

  const reservesMapping: ReservesMapping = {};
  for (const reserve of reserves.reservesData) {
    reservesMapping[reserve.underlyingAsset] = reserve;
  }

  const userAssets: SingleAssetUsageInfo[] = [];
  for (const userReserve of userReserves.userReserves) {
    const reserveData = reservesMapping[userReserve.underlyingAsset];
    userAssets.push({
      symbol: reserveData.symbol,
      supplied:
        (((parseInt(userReserve.scaledATokenBalance) /
          10 ** reserveData.decimals) *
          parseInt(reserveData.priceInMarketReferenceCurrency)) /
          10 ** reserves.baseCurrencyData.marketReferenceCurrencyDecimals) *
        marketCurrencyMultiplier,
      borrowed:
        ((((parseInt(userReserve.scaledVariableDebt) ||
          parseInt(userReserve.principalStableDebt)) /
          10 ** reserveData.decimals) *
          parseInt(reserveData.priceInMarketReferenceCurrency)) /
          10 ** reserves.baseCurrencyData.marketReferenceCurrencyDecimals) *
        marketCurrencyMultiplier,
    });
  }
  return {
    healthFactor: healthFactor,
    netAPY: 5.6,
    totalSupplied: userAssets.reduce(
      (acc, asset) => acc + (asset.supplied === undefined ? 0 : asset.supplied),
      0
    ),
    totalBorrowed: userAssets.reduce(
      (acc, asset) => acc + (asset.borrowed === undefined ? 0 : asset.borrowed),
      0
    ),
    assets: userAssets,
  };
}

export function getAllTrackedAccounts(): ChainAccount[] {
  return [];
}
