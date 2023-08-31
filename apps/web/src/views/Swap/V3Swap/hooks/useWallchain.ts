import { useState, useEffect, useMemo } from 'react'
import type WallchainSDK from '@wallchain/sdk'
import type { TMEVFoundResponse } from '@wallchain/sdk'
import { TOptions } from '@wallchain/sdk'
import { Token, TradeType, Currency, ChainId } from '@pancakeswap/sdk'
import { SmartRouterTrade } from '@pancakeswap/smart-router/evm'
import { useWalletClient } from 'wagmi'
import useSWRImmutable from 'swr/immutable'
import useAccountActiveChain from 'hooks/useAccountActiveChain'
import { useUserSlippage } from '@pancakeswap/utils/user'
import { INITIAL_ALLOWED_SLIPPAGE } from 'config/constants'
import { basisPointsToPercent } from 'utils/exchange'
import { FeeOptions } from '@pancakeswap/v3-sdk'
import { captureException } from '@sentry/nextjs'
import { useActiveChainId } from 'hooks/useActiveChainId'
import { atom, useAtom } from 'jotai'

import Bottleneck from 'bottleneck'
import { Address, Hex } from 'viem'
import { WallchainKeys, WallchainPairs } from 'config/wallchain'
import { useSwapCallArguments } from './useSwapCallArguments'

interface SwapCall {
  address: Address
  calldata: Hex
  value: Hex
}
interface WallchainSwapCall {
  getCall: () => Promise<SwapCall | { error: string }>
}

export type WallchainStatus = 'found' | 'pending' | 'not-found'
export type TWallchainMasterInput = [TMEVFoundResponse['searcherRequest'], string] | undefined

const limiter = new Bottleneck({
  maxConcurrent: 1, // only allow one request at a time
  minTime: 250, // add 250ms of spacing between requests
  highWater: 1, // only queue 1 request at a time, newer request will drop older
})

const overrideAddresses = {
  // MetaSwapWrapper
  56: '0x662ccE1A8A940492fD33F6B47459D9EFDd039d5A',
}

const loadData = async (account: string, sdk: WallchainSDK, swapCalls: SwapCall[]) => {
  if (await sdk.supportsChain()) {
    const approvalFor = await sdk.getSpenderForAllowance()

    try {
      const resp = await sdk.checkForMEV({
        from: account,
        to: swapCalls[0].address,
        value: swapCalls[0].value,
        data: swapCalls[0].calldata,
      })
      if (resp.MEVFound) {
        return ['found', approvalFor, resp.searcherRequest, resp.searcherSignature] as const
      }
    } catch (e) {
      return ['not-found', undefined, undefined, undefined]
    }
  }
  return ['not-found', undefined, undefined, undefined]
}
const wrappedLoadData = limiter.wrap(loadData)

const extractAddressFromCurrency = (currency: Currency): `0x${string}` => {
  return currency.isNative ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : (currency as Token).address
}

const extractTokensFromTrade = (trade: SmartRouterTrade<TradeType> | undefined | null) => {
  const inputCurrency = trade?.inputAmount?.currency
  const outputCurrency = trade?.outputAmount?.currency
  const srcToken = inputCurrency ? extractAddressFromCurrency(inputCurrency) : false
  const dstToken = outputCurrency ? extractAddressFromCurrency(outputCurrency) : false

  return [srcToken, dstToken] as [false | `0x${string}`, false | `0x${string}`]
}

function useWallchainSDK() {
  const { data: walletClient } = useWalletClient()
  const { chainId } = useActiveChainId()
  const { data: wallchainSDK } = useSWRImmutable(
    chainId === ChainId.BSC && walletClient && ['wallchainSDK', walletClient.account, walletClient.chain],
    async () => {
      const WallchainSDK = (await import('@wallchain/sdk')).default
      return new WallchainSDK({
        keys: WallchainKeys,
        provider: walletClient?.transport as TOptions['provider'],
        overrideAddresses,
      })
    },
  )

  return wallchainSDK
}

const wallchainStatusAtom = atom<WallchainStatus>('pending')
export function useWallchainStatus() {
  return useAtom(wallchainStatusAtom)
}

export function useWallchainApi(
  trade?: SmartRouterTrade<TradeType>,
  deadline?: bigint,
  feeOptions?: FeeOptions,
): [WallchainStatus, string | undefined, [TMEVFoundResponse['searcherRequest'], string] | undefined] {
  const [approvalAddress, setApprovalAddress] = useState<undefined | string>(undefined)
  const [status, setStatus] = useWallchainStatus()
  const [masterInput, setMasterInput] = useState<undefined | [TMEVFoundResponse['searcherRequest'], string]>(undefined)
  const { data: walletClient } = useWalletClient()
  const { account } = useAccountActiveChain()
  const [allowedSlippageRaw] = useUserSlippage() || [INITIAL_ALLOWED_SLIPPAGE]
  const allowedSlippage = useMemo(() => basisPointsToPercent(allowedSlippageRaw), [allowedSlippageRaw])

  const sdk = useWallchainSDK()

  const swapCalls = useSwapCallArguments(trade, allowedSlippage, account, deadline, feeOptions)

  useEffect(() => {
    if (!sdk || !walletClient || !trade) return
    if (trade.routes.length === 0 || trade.inputAmount.currency.chainId !== ChainId.BSC) return
    const includesPair = trade.routes.some(
      (route) =>
        (route.inputAmount.wrapped.currency.equals(WallchainPairs[0]) &&
          route.outputAmount.wrapped.currency.equals(WallchainPairs[1])) ||
        (route.inputAmount.wrapped.currency.equals(WallchainPairs[1]) &&
          route.outputAmount.wrapped.currency.equals(WallchainPairs[0])),
    )
    if (includesPair) {
      setStatus('pending')
      wrappedLoadData(account, sdk, swapCalls)
        .then(([reqStatus, address, searcherRequest, searcherSignature]) => {
          setStatus(reqStatus as WallchainStatus)
          setApprovalAddress(address)
          setMasterInput([searcherRequest as TMEVFoundResponse['searcherRequest'], searcherSignature])
        })
        .catch((e) => {
          setStatus('not-found')
          setApprovalAddress(undefined)
          setMasterInput(undefined)
          captureException(e)
        })
    } else {
      setStatus('not-found')
      setApprovalAddress(undefined)
      setMasterInput(undefined)
    }
  }, [walletClient, account, swapCalls, sdk, trade, setStatus])

  return [status, approvalAddress, masterInput]
}

export function useWallchainSwapCallArguments(
  trade: SmartRouterTrade<TradeType> | undefined | null,
  previousSwapCalls: { address: `0x${string}`; calldata: `0x${string}`; value: `0x${string}` }[] | undefined | null,
  account: string | undefined | null,
  masterInput?: [TMEVFoundResponse['searcherRequest'], string],
): SwapCall[] | WallchainSwapCall[] {
  const [swapCalls, setSwapCalls] = useState<SwapCall[] | WallchainSwapCall[]>([])
  const { data: walletClient } = useWalletClient()

  const [srcToken, dstToken] = extractTokensFromTrade(trade)
  const amountIn = trade?.inputAmount?.numerator?.toString() as `0x${string}`
  const needPermit = !trade?.inputAmount?.currency?.isNative

  const sdk = useWallchainSDK()

  useEffect(() => {
    if (
      !walletClient ||
      !masterInput ||
      !srcToken ||
      !dstToken ||
      !amountIn ||
      !previousSwapCalls ||
      !previousSwapCalls[0] ||
      !sdk ||
      !account
    ) {
      if (!previousSwapCalls || !previousSwapCalls.length) {
        setSwapCalls([])
      } else {
        setSwapCalls(previousSwapCalls)
      }

      return
    }

    loadData(account, sdk, previousSwapCalls).then(
      async ([status, _approvalAddress, searcherRequest, searcherSignature]) => {
        if (status === 'not-found') {
          setSwapCalls(previousSwapCalls)
        } else {
          const callback = async () => {
            try {
              const spender = (await sdk.getSpender()) as `0x${string}`
              let witness: false | Awaited<ReturnType<typeof sdk.signPermit>> = false

              if (needPermit) {
                witness = await sdk.signPermit(srcToken as `0x${string}`, account, spender, amountIn)
              }

              const data = await sdk.createNewTransaction(
                previousSwapCalls[0].address,
                false,
                previousSwapCalls[0].calldata,
                amountIn,
                previousSwapCalls[0].value,
                srcToken as `0x${string}`,
                dstToken as `0x${string}`,
                searcherSignature as `0x${string}`,
                searcherRequest as unknown as TMEVFoundResponse['searcherRequest'],
                witness,
              )

              return {
                address: data.to as `0x${string}`,
                calldata: data.data as `0x${string}`,
                value: data.value as `0x${string}`,
              }
            } catch (e) {
              return previousSwapCalls[0]
            }
          }

          setSwapCalls([{ getCall: callback }])
        }
      },
    )
  }, [account, previousSwapCalls, masterInput, srcToken, dstToken, amountIn, needPermit, walletClient, sdk])

  return swapCalls
}
