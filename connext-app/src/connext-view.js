import React, { Component }  from 'react'
import * as connext from "@connext/client"
import { Contract, ethers as eth } from "ethers"
//import { Currency, store, toBN } from "./utils"
import { Currency } from './utils/currency'
import { store } from './utils/store'
import tokenArtifacts from "openzeppelin-solidity/build/contracts/ERC20Mintable.json"
import { AddressZero, Zero } from "ethers/constants"
import { formatEther, parseEther } from "ethers/utils"

// Optional URL overrides for custom urls
const overrides = {
  nodeUrl: 'wss://rinkeby.indra.connext.network/api/messaging',
  ethUrl: 'https://rinkeby.indra.connext.network/api/ethprovider',
};

export default class ConnextView extends Component {
	constructor(props) {
		super(props)

		const swapRate = "314.08";
		this.state = {
			address: "",
			balance: {
				channel: { token: Currency.DEI("0", swapRate), ether: Currency.WEI("0", swapRate) },
				onChain: { token: Currency.DEI("0", swapRate), ether: Currency.WEI("0", swapRate) },
			},
			ethprovider: null,
			freeBalanceAddress: null,
			loadingConnext: true,
			maxDeposit: null,
			minDeposit: null,
			pending: { type: "", complete: false, closed: false },
			sendScanArgs: { amount: null, recipient: null },
			swapRate,
			token: null,
			xpub: "",
		}
	}

	async componentDidMount() {
		console.log("...1...")
		// If no mnemonic, create one and save to local storage
		let mnemonic = localStorage.getItem("mnemonic");
		if (!mnemonic) {
			mnemonic = eth.Wallet.createRandom().mnemonic;
			localStorage.setItem("mnemonic", mnemonic);
		}

		const nodeUrl = overrides.nodeUrl || `${window.location.origin.replace(/^http/, "ws")}/api/messaging`;
		const ethUrl = overrides.ethUrl || `${window.location.origin}/api/ethprovider`;
		const ethprovider = new eth.providers.JsonRpcProvider(ethUrl);
		const cfPath = "m/44'/60'/0'/25446";
		const cfWallet = eth.Wallet.fromMnemonic(mnemonic, cfPath).connect(ethprovider);

		const channel = await connext.connect({
			ethProviderUrl: ethUrl,
			logLevel: 5,
			mnemonic,
			nodeUrl,
			store,
		});
		const freeBalanceAddress = channel.freeBalanceAddress || channel.myFreeBalanceAddress;
		const connextConfig = await channel.config();
		const token = new Contract(connextConfig.contractAddresses.Token, tokenArtifacts.abi, cfWallet);
		const swapRate = formatEther(await channel.getLatestSwapRate(AddressZero, token.address));

		console.log(`Client created successfully!`);
		console.log(` - Public Identifier: ${channel.publicIdentifier}`);
		console.log(` - Account multisig address: ${channel.opts.multisigAddress}`);
		console.log(` - CF Account address: ${cfWallet.address}`);
		console.log(` - Free balance address: ${freeBalanceAddress}`);
		console.log(` - Token address: ${token.address}`);
		console.log(` - Swap rate: ${swapRate}`)

		channel.subscribeToSwapRates(AddressZero, token.address, (res) => {
		if (!res || !res.swapRate) return;
			console.log(`Got swap rate upate: ${this.state.swapRate} -> ${formatEther(res.swapRate)}`);
			this.setState({ swapRate: formatEther(res.swapRate) });
		})

		console.log(`Creating a payment profile..`)
		await channel.addPaymentProfile({
			amountToCollateralize: parseEther("10").toString(),
			minimumMaintainedCollateral: parseEther("5").toString(),
			tokenAddress: token.address,
		});

		const freeTokenBalance = await channel.getFreeBalance(token.address);
		const hubFreeBalanceAddress = Object.keys(freeTokenBalance).filter(addr => addr.toLowerCase() !== channel.freeBalanceAddress)[0]
		if (freeTokenBalance[hubFreeBalanceAddress].eq(Zero)) {
			console.log(`Requesting collateral for token ${token.address}`)
			await channel.requestCollateral(token.address);
		} else {
			console.log(`Hub has collateralized us with ${formatEther(freeTokenBalance[hubFreeBalanceAddress])} tokens`)
		}

		this.setState({
			address: cfWallet.address,
			channel,
			ethprovider,
			freeBalanceAddress,
			swapRate,
			token,
			wallet: cfWallet,
			xpub: channel.publicIdentifier,
		});

		console.log("...2...")
		//await this.startPoller();
		//this.setState({ loadingConnext: false });

  }

	render() {
		return <div>ConnextView</div>
	}
}
