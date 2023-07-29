import { ChainNotConfiguredForConnectorError, Connector, normalizeChainId } from "@wagmi/connectors";
import {
  type Address,
  ProviderRpcError,
  ResourceUnavailableRpcError,
  SwitchChainError,
  UserRejectedRequestError,
  createWalletClient,
  custom,
  getAddress,
  numberToHex,
} from "viem";
import { ConnectorNotFoundError, WalletClient, Chain } from "wagmi";
import Provider from "eth-provider";

export type FrameConnectorOptions = {
  fetchOptions?: Omit<RequestInit, "body">,
}

export class FrameConnector extends Connector {
  readonly id: string = 'frame'
  readonly name = 'Frame'
  readonly ready = true;


  // rome-ignore lint/correctness/noUnreachableSuper: <explanation>
  constructor({ chains, options: opts }: { chains?: Chain[], options?: FrameConnectorOptions } = {}) {
    const options = {
      getProvider: async () => {
        if (typeof window === 'undefined') return;
        return Provider('frame');
      },
      ...opts,
    }
    super({ chains, options })
  }

  async connect({ chainId }: { chainId?: number } = {}) {
    try {
      const provider = await this.getProvider()
      if (!provider) throw new ConnectorNotFoundError()

      if (provider.on) {
        provider.on('accountsChanged', this.onAccountsChanged)
        provider.on('chainChanged', this.onChainChanged)
        provider.on('disconnect', this.onDisconnect)
      }

      this.emit('message', { type: 'connecting' })

      const accounts = await provider.request({
        method: 'eth_requestAccounts',
      })

      const account = getAddress(accounts[0] as string)
      // Switch to chain if provided
      let id = await this.getChainId()
      let unsupported = this.isChainUnsupported(id)
      if (chainId && id !== chainId) {
        const chain = await this.switchChain(chainId)
        id = chain.id
        unsupported = this.isChainUnsupported(id)
      }

      return { account, chain: { id, unsupported } }
    } catch (error) {
      if (this.isUserRejectedRequestError(error))
        throw new UserRejectedRequestError(error as Error)
      if ((
        error as ProviderRpcError
      ).code === -32002)
        throw new ResourceUnavailableRpcError(error as ProviderRpcError)
      throw error
    }
  }

  async disconnect() {
    const provider = await this.getProvider()

    if (!provider?.removeListener) return

    provider.removeListener('accountsChanged', this.onAccountsChanged)
    provider.removeListener('chainChanged', this.onChainChanged)
    provider.removeListener('disconnect', this.onDisconnect)
    if (provider?.emit) {
      provider.emit('disconnect')
    }
  }

  async getAccount() {
    const provider = await this.getProvider()
    if (!provider) throw new ConnectorNotFoundError()
    const accounts = await provider.request({
      method: 'eth_accounts',
    })
    // return checksum address
    return getAddress(accounts[0] as string)
  }

  async getChainId() {
    const provider = await this.getProvider()
    if (!provider) throw new ConnectorNotFoundError()
    return provider.request({ method: 'eth_chainId' }).then(normalizeChainId)
  }

  async getProvider() {
    return this.options.getProvider()
  }

  async getWalletClient({ chainId }: { chainId?: number } = {}): Promise<WalletClient> {
    const [ provider, account ] = await Promise.all([
      this.getProvider(),
      this.getAccount(),
    ])
    const chain = this.chains.find((x) => x.id === chainId)
    if (!provider) throw new Error('provider is required.')
    return createWalletClient({
      account,
      chain,
      transport: custom(provider),
    })
  }

  async isAuthorized() {
    try {
      const provider = await this.getProvider()
      if (!provider) throw new ConnectorNotFoundError()
      const account = await this.getAccount()
      return !!account
    } catch {
      return false
    }
  }

  async switchChain(chainId: number) {
    const provider = await this.getProvider()
    if (!provider) throw new ConnectorNotFoundError()
    const id = numberToHex(chainId)

    try {
      await Promise.all([
        provider.request({
          method: 'wallet_switchEthereumChain',
          params: [ { chainId: id } ],
        }),
        new Promise<void>((res) =>
          this.on('change', ({ chain }) => {
            if (chain?.id === chainId) res()
          }),
        ),
      ])
      return (
        this.chains.find((x) => x.id === chainId) ?? {
          id: chainId,
          name: `Chain ${id}`,
          network: `${id}`,
          nativeCurrency: { name: 'Ether', decimals: 18, symbol: 'ETH' },
          rpcUrls: { default: { http: [ '' ] }, public: { http: [ '' ] } },
        }
      )
    } catch (error) {
      const chain = this.chains.find((x) => x.id === chainId)
      if (!chain)
        throw new ChainNotConfiguredForConnectorError({
          chainId,
          connectorId: this.id,
        })

      // Indicates chain is not added to provider
      if (
        (
          error as ProviderRpcError
        ).code === 4902 ||
        // Unwrapping for MetaMask Mobile
        // https://github.com/MetaMask/metamask-mobile/issues/2944#issuecomment-976988719
        (
          error as ProviderRpcError<{ originalError?: { code: number } }>
        )?.data
          ?.originalError?.code === 4902
      ) {
        try {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: id,
                chainName: chain.name,
                nativeCurrency: chain.nativeCurrency,
                rpcUrls: [ chain.rpcUrls.public?.http[0] ?? '' ],
                blockExplorerUrls: this.getBlockExplorerUrls(chain),
              },
            ],
          })

          const currentChainId = await this.getChainId()
          if (currentChainId !== chainId)
            throw new UserRejectedRequestError(
              new Error('User rejected switch after adding network.'),
            )

          return chain
        } catch (error) {
          throw new UserRejectedRequestError(error as Error)
        }
      }

      if (this.isUserRejectedRequestError(error))
        throw new UserRejectedRequestError(error as Error)
      throw new SwitchChainError(error as Error)
    }
  }

  async watchAsset({
                     address,
                     decimals = 18,
                     image,
                     symbol,
                   }: {
    address: Address
    decimals?: number
    image?: string
    symbol: string
  }) {
    const provider = await this.getProvider()
    if (!provider) throw new ConnectorNotFoundError()
    return provider.request({
      method: 'wallet_watchAsset',
      params: {
        type: 'ERC20',
        options: {
          address,
          decimals,
          image,
          symbol,
        },
      },
    })
  }

  protected onAccountsChanged = (accounts: string[]) => {
    if (accounts.length === 0) this.emit('disconnect')
    else
      this.emit('change', {
        account: getAddress(accounts[0] as string),
      })
  }

  protected onChainChanged = (chainId: number | string) => {
    const id = normalizeChainId(chainId)
    const unsupported = this.isChainUnsupported(id)
    this.emit('change', { chain: { id, unsupported } })
  }

  protected onDisconnect = async (error: Error) => {
    // If MetaMask emits a `code: 1013` error, wait for reconnection before disconnecting
    // https://github.com/MetaMask/providers/pull/120
    if ((
      error as ProviderRpcError
    ).code === 1013) {
      const provider = await this.getProvider()
      if (provider) {
        const isAuthorized = await this.getAccount()
        if (isAuthorized) return
      }
    }

    this.emit('disconnect')
  }

  protected isUserRejectedRequestError(error: unknown) {
    return (
      error as ProviderRpcError
    ).code === 4001
  }
}
