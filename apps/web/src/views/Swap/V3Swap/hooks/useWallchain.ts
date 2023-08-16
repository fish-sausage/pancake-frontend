import { useState, useEffect } from 'react'
import type WallchainSDK from '@wallchain/sdk'
import type { TMEVFoundResponse } from '@wallchain/sdk'
import { TOptions } from '@wallchain/sdk'
import { Token, TradeType, Currency, ChainId } from '@pancakeswap/sdk'
import { SmartRouterTrade } from '@pancakeswap/smart-router/evm'
import { useWalletClient } from 'wagmi'
import useSWRImmutable from 'swr/immutable'
import { useActiveChainId } from 'hooks/useActiveChainId'
import { atom, useAtom } from 'jotai'

import Bottleneck from 'bottleneck'
import { Address, Hex } from 'viem'
import { WallchainKeys, WallchainPairs } from 'config/wallchain'

interface SwapCall {
  address: Address
  calldata: Hex
  value: Hex
}
interface WallchainSwapCall {
  getCall: () => Promise<SwapCall>
}

export type WallchainStatus = 'found' | 'pending' | 'not-found'

const wallchainStatusAtom = atom<WallchainStatus>('pending')
export function useWallchainStatus() {
  return useAtom(wallchainStatusAtom)
}

const limiter = new Bottleneck({
  maxConcurrent: 1, // only allow one request at a time
  minTime: 250, // add 250ms of spacing between requests
  highWater: 1, // only queue 1 request at a time, newer request will drop older
})

const overrideAddresses = {
  // MetaSwapWrapper
  56: '0x6346e0a39e2fBbc133e4ce8390ab567108e62aEe',
}

const loadData = async (account: string, sdk: WallchainSDK, swapCalls: SwapCall[]) => {
  const address = overrideAddresses[56]

  if (await sdk.supportsChain()) {
    const response = await sdk.checkForMEV({
      from: account,
      to: swapCalls[0].address,
      value: swapCalls[0].value,
      data: swapCalls[0].calldata,
    })

    if (response.MEVFound) {
      return ['found', address, response.searcher_request, response.searcher_signature] as [
        'found',
        `0x${string}`,
        TMEVFoundResponse['searcher_request'],
        `0x${string}`,
      ]
    }
  }

  return ['not-found', undefined, undefined] as ['not-found', undefined, undefined]
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

export function useWallchainSwapCallArguments(
  trade: SmartRouterTrade<TradeType> | undefined | null,
  previousSwapCalls: { address: `0x${string}`; calldata: `0x${string}`; value: `0x${string}` }[] | undefined | null,
  account: string | undefined | null,
  onForceApproval?: (spender: string) => void,
) {
  const [swapCalls, setSwapCalls] = useState<SwapCall[] | WallchainSwapCall[]>([])
  const { data: walletClient } = useWalletClient()

  const [srcToken, dstToken] = extractTokensFromTrade(trade)
  const amountIn = trade?.inputAmount?.numerator?.toString() as `0x${string}`
  const needPermit = !trade?.inputAmount?.currency?.isNative
  const [, setStatus] = useWallchainStatus()

  const sdk = useWallchainSDK()

  useEffect(() => {
    ;(async () => {
      if (
        !walletClient ||
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

      if (trade?.routes?.length === 0 || trade?.inputAmount?.currency?.chainId !== ChainId.BSC) return
      const includesPair = trade?.routes?.some(
        (route) =>
          (route.inputAmount.wrapped.currency.equals(WallchainPairs[0]) &&
            route.outputAmount.wrapped.currency.equals(WallchainPairs[1])) ||
          (route.inputAmount.wrapped.currency.equals(WallchainPairs[1]) &&
            route.outputAmount.wrapped.currency.equals(WallchainPairs[0])),
      )
      if (includesPair) {
        try {
          const response = await wrappedLoadData(account, sdk, previousSwapCalls)

          if (response[0] === 'found') {
            setStatus('found')
            const hasEnoughAllowance = await sdk.hasEnoughAllowance(srcToken, account, amountIn)
            if (!hasEnoughAllowance) {
              onForceApproval(response[1])
              return
            }
            const callback = async () => {
              try {
                const spender = (await sdk.getSpender()) as `0x${string}`
                const prevVersionOfCall = previousSwapCalls[0]
                let witness: false | Awaited<ReturnType<typeof sdk.signPermit>> = false
                if (needPermit) {
                  witness = await sdk.signPermit(srcToken as `0x${string}`, account, spender, amountIn)
                }

                const newArguments = await sdk.createNewTransaction(
                  account as `0x${string}`,
                  false,
                  prevVersionOfCall.calldata,
                  amountIn,
                  srcToken,
                  dstToken,
                  response[3],
                  { ...response[2], from: account },
                  witness,
                )

                return {
                  address: newArguments.to as `0x${string}`,
                  calldata: newArguments.data as `0x${string}`,
                  value: prevVersionOfCall.value as `0x${string}`,
                }
              } catch (e) {
                return previousSwapCalls[0]
              }
            }

            setSwapCalls([{ getCall: callback }])
            return
          }
          setStatus('not-found')
          setSwapCalls(previousSwapCalls)
        } catch (e) {
          setStatus('not-found')
          setSwapCalls(previousSwapCalls)
        }
      }
    })()
  }, [account, previousSwapCalls, srcToken, dstToken, amountIn, needPermit, walletClient, sdk])

  return swapCalls
}
