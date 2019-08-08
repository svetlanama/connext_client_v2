import React, { Component }  from 'react'
import { Button, CircularProgress, Grid, InputAdornment, Modal, TextField, Tooltip, Typography, withStyles, } from "@material-ui/core"
import * as connext from "@connext/client"
import { Contract, ethers as eth } from "ethers"
//import { Currency, store, toBN } from "./utils"
import { Currency } from './utils/currency'
import { store } from './utils/store'
import { toBN } from './utils/bn'
import interval from "interval-promise"; // TODO: don not install and replace to setInterval
import tokenArtifacts from "openzeppelin-solidity/build/contracts/ERC20Mintable.json"
import { AddressZero, Zero } from "ethers/constants"
import { formatEther, parseEther } from "ethers/utils"


// Optional URL overrides for custom urls
const overrides = {
	nodeUrl: 'wss://rinkeby.indra.connext.network/api/messaging',
	ethUrl: 'https://rinkeby.indra.connext.network/api/ethprovider',
};

const PaymentStates = {
	None: 0,
	Collateralizing: 1,
	CollateralTimeout: 2,
	OtherError: 3,
	Success: 4
};

const styles = theme => ({
  icon: {
    width: "40px",
    height: "40px"
  },
  button: {
    backgroundColor: "#FCA311",
    color: "#FFF"
  },
  modal: {
    position: "absolute",
    top: "-400px",
    left: "150px",
    width: theme.spacing(50),
    backgroundColor: theme.palette.background.paper,
    boxShadow: theme.shadows[5],
    padding: theme.spacing(4),
    outline: "none"
  }
});

// Constants for channel max/min - this is also enforced on the hub
const WITHDRAW_ESTIMATED_GAS = toBN("300000");
const DEPOSIT_ESTIMATED_GAS = toBN("25000");
const HUB_EXCHANGE_CEILING = parseEther("69"); // 69 token
const CHANNEL_DEPOSIT_MAX = parseEther("30"); // 30 token


class ConnextView extends Component {
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
			// WITHDRAW
			recipient: {
				display: "",
				value: undefined,
				error: undefined,
			},
			// TIPPING
			tipRecipient: {
				display: "",
				value: undefined,
				error: undefined,
			},
			tipAmount: { display: "", error: null, value: null }
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
		await this.startPoller();
		this.setState({ loadingConnext: false });

	}

	// ************************************************* //
	//                    Pollers                        //
	// ************************************************* //

	async startPoller() {
		await this.refreshBalances();
		await this.setDepositLimits();
		await this.autoDeposit();
		await this.autoSwap();
		interval(async (iteration, stop) => {
			await this.refreshBalances();
			await this.setDepositLimits();
			await this.autoDeposit();
			await this.autoSwap();
		}, 3000);
	}

	async refreshBalances() {
		const { address, balance, channel, ethprovider, swapRate, token } = this.state;
		const freeEtherBalance = await channel.getFreeBalance();
		const freeTokenBalance = await channel.getFreeBalance(token.address);
		balance.onChain.ether = Currency.WEI(await ethprovider.getBalance(address), swapRate);
		balance.onChain.token = Currency.DEI(await token.balanceOf(address), swapRate);
		balance.channel.ether = Currency.WEI(freeEtherBalance[this.state.freeBalanceAddress], swapRate);
		balance.channel.token = Currency.DEI(freeTokenBalance[this.state.freeBalanceAddress], swapRate);
		this.setState({ balance });
	}

	async setDepositLimits() {
		const { swapRate, ethprovider } = this.state;
		let gasPrice = await ethprovider.getGasPrice();
		// default multiple is 1.5, leave 2x for safety
		let totalDepositGasWei = DEPOSIT_ESTIMATED_GAS.mul(toBN(2)).mul(gasPrice);
		let totalWithdrawalGasWei = WITHDRAW_ESTIMATED_GAS.mul(gasPrice);
		const minDeposit = Currency.WEI(totalDepositGasWei.add(totalWithdrawalGasWei), swapRate);
		const maxDeposit = Currency.DEI(CHANNEL_DEPOSIT_MAX, swapRate);
		this.setState({ maxDeposit, minDeposit });
	}

	async autoDeposit() {
		const { balance, channel, minDeposit, maxDeposit, pending, token } = this.state;
		if (!channel || (pending.type === "deposit" && !pending.complete)) return;
		if (!(await channel.getChannel()).available) {
		console.warn(`Channel not available yet.`);
			return;
		}
		const bnBalance = { ether: toBN(balance.onChain.ether), token: toBN(balance.onChain.token) };
		const minWei = minDeposit.toWEI().floor();
		const maxWei = maxDeposit.toWEI().floor();

		if (bnBalance.token.gt(Zero)) {
			const tokenDepositParams = {
				amount: bnBalance.token.toString(),
				assetId: token.address.toLowerCase(),
			};
			const channelState = await channel.getChannel();
			console.log(
			 `Attempting to deposit ${tokenDepositParams.amount} tokens into channel: ${JSON.stringify(
			   channelState,
			   null,
			   2,
			 )}...`,
			);
			this.setPending({ type: "deposit", complete: false, closed: false });
			const result = await channel.deposit(tokenDepositParams);
			this.setPending({ type: "deposit", complete: true, closed: false });
			console.log(`Successfully deposited! Result: ${JSON.stringify(result, null, 2)}`);
		}

		if (bnBalance.ether.gt(minWei)) {
			if (bnBalance.ether.gt(maxWei)) {
				console.log(
				`Attempting to deposit more than the limit: ` +
				`${formatEther(bnBalance.ether)} > ${maxDeposit.toETH()}`,
				);
				return;
			}
			const ethDepositParams = { amount: bnBalance.ether.sub(minWei).toString() };
			const channelState = await channel.getChannel();
			console.log(
			 `Attempting to deposit ${ethDepositParams.amount} wei into channel: ${JSON.stringify(
			   channelState,
			   null,
			   2,
			 )}...`,
			);
			this.setPending({ type: "deposit", complete: false, closed: false });
			const result = await channel.deposit(ethDepositParams);
			this.setPending({ type: "deposit", complete: true, closed: false });
			console.log(`Successfully deposited! Result: ${JSON.stringify(result, null, 2)}`);
		}
	}

	async autoSwap() {
		const { balance, channel, swapRate, token } = this.state;
		const weiBalance = toBN(balance.channel.ether.toWEI().floor());
		const tokenBalance = toBN(balance.channel.token.toDEI().floor());
		if (weiBalance.gt(Zero) && tokenBalance.lte(HUB_EXCHANGE_CEILING)) {
			console.log(`Attempting to swap ${balance.channel.ether.toETH()} for dai at rate ${swapRate}`);
			await channel.swap({
			 amount: weiBalance.toString(),
			 fromAssetId: AddressZero,
			 swapRate: parseEther(swapRate).toString(),
			 toAssetId: token.address,
			});
		}
	}

	setPending(pending) {
		this.setState({ pending });
	}

	closeConfirmations() {
		const { pending } = this.state;
		this.setState({ pending: { ...pending, closed: true } });
	}

	// ************************************************* //
	//                    withdraw                        //
	// ************************************************* //
	async withdrawalHandler(withdrawEth) {
		const { balance, channel } = this.state
		const recipient = this.state.recipient.value
		console.log(">> recipient: ", recipient)
		if (!recipient) return

		console.log(">>>>> toETH().amount: ", balance.channel.ether.toETH().amount)
		console.log(">>>>> toETH(): ", balance.channel.ether.toETH())
		const amount = parseEther(balance.channel.ether.toETH().amount)
		if (amount.lte(Zero)) return
		console.log(">>>>> amount: ", amount.toString())

		this.setPending({ type: "withdrawal", complete: false, closed: false })
		this.setState({ withdrawing: true });

		//TODO: waiting for Connext message in discord
		const result = await channel.withdraw({ amount: amount.toString(), recipient });
		this.setState({ withdrawing: false })

		this.setPending({ type: "withdrawal", complete: true, closed: false })
		console.log(`Cashout result: ${JSON.stringify(result)}`)
		//history.push("/")
	}

	async updateRecipientHandler(value) {
		let recipient = value
		let error

		//TODO: validate
		// if (value.includes("ethereum:")) {
		// 	recipient = value.split(":")[1]
		// }
		//
		// if (recipient === "") {
		// 	error = "Please provide an address"
		// } else if (!isHexString(recipient)) {
		// 	error = `Invalid hex string: ${recipient}`
		// } else if (arrayify(recipient).length !== 20) {
		// 	error = `Invalid length: ${recipient}`
		// }

		this.setState({
			recipient: {
				display: value,
				value: error ? undefined : recipient,
				error,
			},
			scan: false
		});
	}

	// ************************************************* //
	//                    TIPPING                        //
	// ************************************************* //
	async updateTIPRecipientHandler(rawValue) {
		const xpubLen = 111
		let value = null, error = null
		value = rawValue
		if (!value.startsWith('xpub')) {
			error = "Invalid recipient: should start with xpub"
		}
		if (!error && value.length !== xpubLen) {
			error = `Invalid recipient: expected ${xpubLen} characters, got ${value.length}`
		}
		this.setState({
			tipRecipient: {
				display: rawValue,
				error,
				value: error ? null : value,
			}
		})
	}

	async paymentHandler() {
		console.log(">>> paymentHandler")
		const { channel } = this.state;
		const { tipAmount, tipRecipient } = this.state;
		if (tipAmount.error || tipRecipient.error) return;
			// TODO: check if recipient needs collateral & tell server to collateralize if more is needed
		console.log(">>> 1...")
		try {
			console.log(">>> 2...")
			console.log(`Sending ${tipAmount.value} to ${tipRecipient.value}`);
			//TODO: here is sending does not work waiting for PR of Connext
			//issue: https://github.com/ConnextProject/indra-v2/issues/241
			await channel.transfer({
				assetId: AddressZero, // TODO: token address
				amount: tipAmount.value.toDEI().floor(),
				recipient: tipRecipient.value,
			});
			this.setState({ showReceipt: true, paymentState: PaymentStates.Success });
		} catch (e) {
			console.log(">>> 3...")
			console.error(`Unexpected error sending payment: ${e.message}`);
			console.error(e)
			this.setState({ paymentState: PaymentStates.OtherError, showReceipt: true });
		}
	}

	async updateAmountHandler(rawValue) {
		const { balance } = this.state
		let value = null, error = null
		try {
			value = Currency.DAI(rawValue)
		} catch (e) {
			error = e.message
		}
		if (value && value.amountWad.gt(balance.channel.ether.toETH().amountWad)) {
			error = `Invalid amount: must be less than your balance`
		}
		if (value && value.amountWad.lte(Zero)) {
			error = "Invalid amount: must be greater than 0"
		}
		this.setState({
			tipAmount: {
				display: rawValue,
				error,
				value: error ? null : value,
			}
		})
	}

	render() {
		const { classes } = this.props
		const {
			address,
			balance,
			channel,
			swapRate,
			maxDeposit,
			minDeposit,
			pending,
			sendScanArgs,
			xpub,
			recipient,
			tipRecipient,
			tipAmount,
		} = this.state

		const minEth = minDeposit ? minDeposit.toETH().format() : '?.??'
		const maxEth = maxDeposit ? maxDeposit.toETH().format() : '?.??'
		const maxDai = maxDeposit ? maxDeposit.toDAI().format() : '?.??'

		var depositTo = `Deposit to address: ${address}`
		var depositMaxMin = `maxDeposit=${maxEth} minDeposit=${minEth}`
		var onChannel = `Deposited on Channel: ERC20 = ${balance.channel.token.toDAI()}, ETH = ${ balance.channel.ether.toETH()}`
		var onChain = `On-Chain: ERC20 = ${balance.onChain.token.toDAI()}, ETH = ${ balance.onChain.ether.toETH()}`
		return <div>
			<div>{ onChannel }</div>
			<div>{ onChain }</div>
			<br/>
			<div>{ depositTo }</div>
			<div>{ depositMaxMin }</div>
			<br/>
			<div> WITHDRAW:
				<TextField
					style={{ width: "100%" }}
					id="outlined-with-placeholder"
					label="Address"
					placeholder="0x0..."
					value={recipient.display || ""}
					onChange={evt => this.updateRecipientHandler(evt.target.value)}
					margin="normal"
					variant="outlined"
					required
					helperText={recipient.error}
					error={!!recipient.error}
				/>
				<Button
					className={classes.button}
					fullWidth
					onClick={() => this.withdrawalHandler(true)}
					disabled={!recipient.value}
				>
				Cash Out Eth
				</Button>
			 </div>
			 <br/>
			 <div> TIP:
				<TextField
					fullWidth
					id="outlined-number"
					label="Amount"
					value={tipAmount.display}
					type="number"
					margin="normal"
					variant="outlined"
					onChange={evt => this.updateAmountHandler(evt.target.value)}
					error={tipAmount.error !== null}
					helperText={tipAmount.error}
				/>
 				<TextField
 					style={{ width: "100%" }}
 					id="outlined-with-placeholder"
 					label="Address"
 					placeholder="0x0..."
 					value={tipRecipient.display || ""}
 					onChange={evt => this.updateTIPRecipientHandler(evt.target.value)}
 					margin="normal"
 					variant="outlined"
 					required
 					helperText={tipRecipient.error}
 					error={!!tipRecipient.error}
 				/>
				<Button
					className={classes.button}
					disabled={!!tipAmount.error || !!tipRecipient.error}
					fullWidth
					onClick={() => this.paymentHandler()}
					size="large"
					variant="contained"
					>
					TIP
				</Button>
 			 </div>
		</div>
	}
}
export default withStyles(styles)(ConnextView);
