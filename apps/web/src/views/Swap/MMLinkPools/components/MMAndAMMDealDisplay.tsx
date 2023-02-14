import { Currency, Trade, TradeType } from '@pancakeswap/sdk'
import { Box, Text } from '@pancakeswap/uikit'
import { useRouter } from 'next/router'

import { Field } from 'state/swap/actions'
import { TradeWithMM } from '../types'

// for testing purpose, will remove later
export const MMAndAMMDealDisplay: React.FC<{
  independentField: Field
  isMMBetter: boolean
  v2Trade?: Trade<Currency, Currency, TradeType>
  mmTrade?: TradeWithMM<Currency, Currency, TradeType>
  mmQuoteExpiryRemainingSec?: number
  errorMessage?: string
  rfqId?: string
}> = ({
  isMMBetter = false,
  independentField,
  v2Trade,
  mmTrade,
  mmQuoteExpiryRemainingSec,
  errorMessage = 'none',
  rfqId = 'none',
}) => {
  const isExactIn = independentField === Field.INPUT
  const dealInANdOut = isExactIn ? '(out)' : '(in)'
  const { query } = useRouter()
  if (query['dev-mode'])
    return (
      <Box pl="20px" pt="10px">
        <Text color="textSubtle">
          type: <Text display="inline-block">{isExactIn ? 'ExactIn' : 'ExactOut'}</Text>
        </Text>
        <Text color="textSubtle">
          <Text display="inline-block" color="transparent">
            A
          </Text>
          MM Deal{dealInANdOut}:{' '}
          <Text display="inline-block">
            {(isExactIn ? mmTrade?.outputAmount?.toSignificant(6) : mmTrade?.inputAmount?.toSignificant(6)) ?? 'null'}
          </Text>
        </Text>
        <Text color="textSubtle">
          AMM Deal{dealInANdOut}:{' '}
          <Text display="inline-block">
            {(isExactIn ? v2Trade?.outputAmount?.toSignificant(6) : v2Trade?.inputAmount?.toSignificant(6)) ?? 'null'}
          </Text>
        </Text>
        <Text color="textSubtle">
          MM win: <Text display="inline-block">{`${isMMBetter}`}</Text>
        </Text>
        <Text color="textSubtle">
          Quote Expiry In:{' '}
          <Text display="inline-block">{`${mmQuoteExpiryRemainingSec > 0 ? mmQuoteExpiryRemainingSec : '?'}`} SEC</Text>
        </Text>
        <Text color="textSubtle">
          Error Message: <Text display="inline-block">{errorMessage}</Text>
        </Text>
        <Text color="textSubtle">
          RfqId: <Text display="inline-block">{rfqId}</Text>
        </Text>
      </Box>
    )
  return null
}