import { useTranslation } from '@pancakeswap/localization'
import { Currency } from '@pancakeswap/sdk'
import { ChainId } from '@pancakeswap/chains'
import { useAtom, useAtomValue } from 'jotai'
import { useRouter } from 'next/router'
import { ParsedUrlQuery } from 'querystring'
import { useCallback, useEffect } from 'react'
import { BuyCryptoState, buyCryptoReducerAtom } from 'state/buyCrypto/reducer'
import { useAccount } from 'wagmi'
import toString from 'lodash/toString'
import { useActiveChainId } from 'hooks/useActiveChainId'
import formatLocaleNumber from 'utils/formatLocaleNumber'
import ceil from 'lodash/ceil'
import min from 'lodash/min'
import max from 'lodash/max'
import toNumber from 'lodash/toNumber'
import toUpper from 'lodash/toUpper'

import { MOONPAY_API_KEY, MERCURYO_WIDGET_ID, MOONPAY_BASE_URL } from 'config/constants/endpoints'
import { SUPPORTED_ONRAMP_TOKENS, moonpayCurrencyChainIdentifier } from 'views/BuyCrypto/constants'
import { Field, replaceBuyCryptoState, selectCurrency, setMinAmount, setUsersIpAddress, typeInput } from './actions'

type CurrencyLimits = {
  code: string
  maxBuyAmount: number
  minBuyAmount: number
}

const defaultTokenByChain = {
  [ChainId.ETHEREUM]: 'ETH',
  [ChainId.BSC]: 'BNB',
  [ChainId.ZKSYNC]: 'ETH',
  [ChainId.ARBITRUM_ONE]: 'ETH',
}

export function useBuyCryptoState() {
  return useAtomValue(buyCryptoReducerAtom)
}

function parseTokenAmountURLParameter(urlParam: any): string {
  return typeof urlParam === 'string' && !Number.isNaN(parseFloat(urlParam)) ? urlParam : ''
}

interface LimitQuote {
  baseCurrency: CurrencyLimits
  quoteCurrency: CurrencyLimits
}

function getMinMaxAmountCap(quotes: LimitQuote[]): LimitQuote {
  return quotes.reduce((bestQuote, quote) => {
    if (!bestQuote) return quote

    return {
      baseCurrency: {
        code: bestQuote.baseCurrency.code,
        maxBuyAmount: min([bestQuote.baseCurrency.maxBuyAmount, quote.baseCurrency.maxBuyAmount]),
        minBuyAmount: max([bestQuote.baseCurrency.minBuyAmount, quote.baseCurrency.minBuyAmount]),
      },
      quoteCurrency: {
        code: bestQuote.quoteCurrency.code,
        maxBuyAmount: min([bestQuote.quoteCurrency.maxBuyAmount, quote.quoteCurrency.maxBuyAmount]),
        minBuyAmount: max([bestQuote.quoteCurrency.minBuyAmount, quote.quoteCurrency.minBuyAmount]),
      },
    }
  })
}

const fetchLimitOfMer = async (inputCurrencyId: string, outputCurrencyId: string) => {
  try {
    const response = await fetch(
      `https://api.mercuryo.io/v1.6/widget/buy/rate?widget_id=${MERCURYO_WIDGET_ID}&type=buy&from=${toUpper(
        inputCurrencyId,
      )}&to=${toUpper(outputCurrencyId)}&amount=1`,
    )

    if (!response.ok) {
      throw new Error('Failed to fetch minimum buy amount')
    }

    const limitQuote = await response.json()

    if (limitQuote[toUpper(inputCurrencyId)] || limitQuote[toUpper(outputCurrencyId)]) {
      return undefined
    }

    return {
      baseCurrency: {
        code: inputCurrencyId.toLowerCase(),
        maxBuyAmount: toNumber(limitQuote[toUpper(inputCurrencyId)]?.max),
        minBuyAmount: toNumber(limitQuote[toUpper(inputCurrencyId)]?.min),
      },
      quoteCurrency: {
        code: outputCurrencyId.toUpperCase(),
        maxBuyAmount: toNumber(limitQuote[toUpper(outputCurrencyId)]?.max),
        minBuyAmount: toNumber(limitQuote[toUpper(outputCurrencyId)]?.min),
      },
    }
  } catch (error) {
    console.error('fetchLimitOfMer: ', error)
    return undefined
  }
}

const fetchLimitOfMoonpay = async (inputCurrencyId: string, outputCurrencyId: string, chainId: number) => {
  try {
    const baseCurrency = `${outputCurrencyId.toLowerCase()}${moonpayCurrencyChainIdentifier[chainId]}`
    const response = await fetch(
      `${MOONPAY_BASE_URL}/v3/currencies/${baseCurrency}/limits?apiKey=${MOONPAY_API_KEY}&baseCurrencyCode=${inputCurrencyId.toLowerCase()}&areFeesIncluded=true`,
    )

    if (!response.ok) {
      return undefined
    }

    const moonpayLimitQuote = await response.json()

    if (!moonpayLimitQuote.baseCurrency || !moonpayLimitQuote.quoteCurrency) {
      return undefined
    }

    return moonpayLimitQuote
  } catch (error) {
    console.error('fetchLimitOfMoonpay: ', error)
    return undefined
  }
}

export const fetchMinimumBuyAmount = async (
  inputCurrencyId: string,
  outputCurrencyId: string,
  chainId: number,
): Promise<LimitQuote | undefined> => {
  try {
    const mercuryLimitQuote = await fetchLimitOfMer(inputCurrencyId, outputCurrencyId)
    const moonpayLimitQuote = await fetchLimitOfMoonpay(inputCurrencyId, outputCurrencyId, chainId)

    const quotes = [moonpayLimitQuote, mercuryLimitQuote].filter(Boolean)

    return quotes?.length > 0 ? getMinMaxAmountCap(quotes) : undefined
  } catch (error) {
    console.error('An error occurred while fetching the minimum buy amount:', error)
    return undefined
  }
}

// from the current swap inputs, compute the best trade and return it.
export function useBuyCryptoErrorInfo(
  typedValue: string,
  minAmount: number,
  minBaseAmount: number,
  maxAmount: number,
  maxBaseAmount: number,
  inputCurrencyId: string,
  outputCurrencyId: string,
): {
  amountError: string | undefined
  inputError: string
} {
  const { address: account } = useAccount()
  const {
    t,
    currentLanguage: { locale },
  } = useTranslation()
  let inputError: string | undefined
  const isMinError = Number(typedValue) < minAmount
  const isMaxError = Number(typedValue) > maxAmount

  let amountError: undefined | string

  if (isMinError) {
    amountError = t(
      'The minimum purchasable amount is %minAmount% %fiatCurrency% / %minCryptoAmount% %cryptoCurrency%',
      {
        minAmount: formatLocaleNumber({
          number: minAmount,
          locale,
        }),
        fiatCurrency: inputCurrencyId,
        minCryptoAmount: formatLocaleNumber({ locale, number: minBaseAmount }),
        cryptoCurrency: outputCurrencyId,
      },
    )
  } else if (isMaxError) {
    amountError = t(
      'The maximum purchasable amount is %maxAmount% %fiatCurrency% / %maxCryptoAmount% %cryptoCurrency%',
      {
        maxAmount: formatLocaleNumber({
          number: maxAmount,
          locale,
        }),
        fiatCurrency: inputCurrencyId,
        maxCryptoAmount: formatLocaleNumber({ locale, number: maxBaseAmount }),
        cryptoCurrency: outputCurrencyId,
      },
    )
  }

  if (!account) {
    inputError = t('Connect Wallet')
  }

  if (isMinError) {
    inputError = inputError ?? t('Amount too low')
  } else if (isMaxError) {
    inputError = inputError ?? t('Amount too high')
  }

  if (typedValue === '') {
    inputError = inputError ?? t('Enter an amount')
  }

  return {
    amountError,
    inputError,
  }
}

export function useBuyCryptoActionHandlers(): {
  onFieldAInput: (typedValue: string) => void
  onCurrencySelection: (field: Field, currency: Currency) => void
  onLimitAmountUpdate: (minAmount: number, minBaseAmount: number, maxAmount: number, maxBaseAmount: number) => void
  onUsersIp: (ip: string | null) => void
} {
  const [, dispatch] = useAtom(buyCryptoReducerAtom)

  const onFieldAInput = useCallback(
    (typedValue: string) => {
      dispatch(typeInput({ typedValue }))
    },
    [dispatch],
  )

  const onCurrencySelection = useCallback((field: Field, currency: Currency) => {
    dispatch(
      selectCurrency({
        field,
        currencyId: currency.symbol,
      }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onLimitAmountUpdate = useCallback(
    (minAmount: number, minBaseAmount: number, maxAmount: number, maxBaseAmount: number) => {
      dispatch(
        setMinAmount({
          minAmount,
          minBaseAmount,
          maxAmount,
          maxBaseAmount,
        }),
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const onUsersIp = useCallback((ip: string | null) => {
    dispatch(
      setUsersIpAddress({
        ip,
      }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    onFieldAInput,
    onCurrencySelection,
    onLimitAmountUpdate,
    onUsersIp,
  }
}

const DEFAULT_FIAT_CURRENCY = 'USD'

export async function queryParametersToBuyCryptoState(
  parsedQs: ParsedUrlQuery,
  account: string | undefined,
  chainId: number,
): Promise<BuyCryptoState> {
  const inputCurrency = parsedQs.inputCurrency as any
  const defaultCurr = SUPPORTED_ONRAMP_TOKENS.includes(inputCurrency) ? inputCurrency : defaultTokenByChain[chainId]
  const limitAmounts = await fetchMinimumBuyAmount(DEFAULT_FIAT_CURRENCY, defaultCurr, chainId)

  return {
    [Field.INPUT]: {
      currencyId: DEFAULT_FIAT_CURRENCY,
    },
    [Field.OUTPUT]: {
      currencyId: defaultCurr as string,
    },
    typedValue: parseTokenAmountURLParameter(parsedQs.exactAmount),
    // UPDATE
    minAmount: limitAmounts?.baseCurrency?.minBuyAmount,
    minBaseAmount: limitAmounts?.quoteCurrency?.minBuyAmount,
    maxAmount: limitAmounts?.baseCurrency?.maxBuyAmount,
    maxBaseAmount: limitAmounts?.quoteCurrency?.maxBuyAmount,
    recipient: account,
    userIpAddress: null,
  }
}

export function calculateDefaultAmount(minAmount: number, currencyCode: string): number {
  switch (currencyCode) {
    case 'USD':
      return 300
    case 'EUR':
      return 200
    case 'GBP':
      return 200
    case 'HKD':
      return 2000
    case 'CAD':
      return 400
    case 'AUD':
      return 400
    case 'BRL':
      return 1000
    case 'JPY':
      return 40000
    case 'KRW':
      return 300000
    case 'VND':
      return 6000000
    default:
      return ceil(minAmount * 10)
  }
}

export function useDefaultsFromURLSearch(account: string | undefined) {
  const [, dispatch] = useAtom(buyCryptoReducerAtom)
  const { chainId } = useActiveChainId()
  const { address } = useAccount()
  const { query, isReady } = useRouter()

  useEffect(() => {
    const fetchData = async () => {
      if (!isReady || !chainId) return
      const parsed = await queryParametersToBuyCryptoState(query, account, chainId)

      dispatch(
        replaceBuyCryptoState({
          typedValue: parsed.minAmount
            ? toString(calculateDefaultAmount(parsed.minAmount, parsed[Field.INPUT].currencyId))
            : '',
          minAmount: parsed.minAmount,
          minBaseAmount: parsed.minBaseAmount,
          maxAmount: parsed.maxAmount,
          maxBaseAmount: parsed.maxBaseAmount,
          inputCurrencyId: parsed[Field.OUTPUT].currencyId,
          outputCurrencyId: parsed[Field.INPUT].currencyId,
          recipient: null,
        }),
      )
    }
    fetchData()
  }, [dispatch, query, isReady, account, chainId, address])
}
