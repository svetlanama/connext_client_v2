import React, { Component }  from 'react'
import { Button, CircularProgress, Grid, InputAdornment, Modal, TextField, Tooltip, Typography, withStyles, } from "@material-ui/core"
import * as connext from "@connext/client"
import { Contract, ethers as eth } from "ethers"
//import { Currency, store, toBN } from "./utils"
import { Currency } from './utils/currency'
import { store } from './utils/store'
import { toBN, inverse, minBN, tokenToWei, weiToToken } from './utils/bn'
import interval from "interval-promise"; // TODO: don not install and replace to setInterval
import tokenArtifacts from "openzeppelin-solidity/build/contracts/ERC20Mintable.json"
import { AddressZero, Zero } from "ethers/constants"
import { formatEther, parseEther } from "ethers/utils"
//import { Currency, inverse, store, minBN, toBN, tokenToWei, weiToToken } from "./utils";


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
const MAX_CHANNEL_VALUE = Currency.DAI("30");

class ConnextView extends Component {
	constructor(props) {
		super(props)

		const swapRate = "314.08";
		this.state = {
			address: "",
			balance: {
				channel: {
					ether: Currency.ETH("0", swapRate),
					token: Currency.DAI("0", swapRate),
					total: Currency.ETH("0", swapRate),
				},
				onChain: {
					ether: Currency.ETH("0", swapRate),
					token: Currency.DAI("0", swapRate),
					total: Currency.ETH("0", swapRate),
				},
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
		// If no mnemonic, create one and save to local storage
		let mnemonic = localStorage.getItem("mnemonic");
		if (!mnemonic) {
			mnemonic = eth.Wallet.createRandom().mnemonic;
			localStorage.setItem("mnemonic", mnemonic);
		}

		const nodeUrl =
		overrides.nodeUrl || `${window.location.origin.replace(/^http/, "ws")}/api/messaging`;
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

		const channelAvailable = async () => {
			const chan = await channel.getChannel();
			return chan && chan.available;
		};
		const interval = 1;
		while (!(await channelAvailable())) {
			console.info(`Waiting ${interval} more seconds for channel to be available`);
			await new Promise(res => setTimeout(() => res(), interval * 1000));
		}

		const freeBalanceAddress = channel.freeBalanceAddress || channel.myFreeBalanceAddress;
		const connextConfig = await channel.config();
		const token = new Contract(connextConfig.contractAddresses.Token, tokenArtifacts.abi, cfWallet);
		const swapRate = await channel.getLatestSwapRate(AddressZero, token.address);
		const invSwapRate = inverse(swapRate)

		console.log(`Client created successfully!`);
		console.log(` - Public Identifier: ${channel.publicIdentifier}`);
		console.log(` - Account multisig address: ${channel.opts.multisigAddress}`);
		console.log(` - CF Account address: ${cfWallet.address}`);
		console.log(` - Free balance address: ${freeBalanceAddress}`);
		console.log(` - Token address: ${token.address}`);
		console.log(` - Swap rate: ${swapRate} or ${invSwapRate}`)

		channel.subscribeToSwapRates(AddressZero, token.address, (res) => {
		if (!res || !res.swapRate) return;
			console.log(`Got swap rate upate: ${this.state.swapRate} -> ${res.swapRate}`);
			this.setState({ swapRate: res.swapRate });
		})

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
		const { freeBalanceAddress, swapRate, token } = this.state;
		const { address, balance, channel, ethprovider } = this.state;
		if (!channel) { return; }
		const getTotal = (ether, token) => Currency.WEI(ether.wad.add(token.toETH().wad), swapRate);
		const freeEtherBalance = await channel.getFreeBalance();
		const freeTokenBalance = await channel.getFreeBalance(token.address);
		balance.onChain.ether = Currency.WEI(await ethprovider.getBalance(address), swapRate).toETH();
		balance.onChain.token = Currency.DEI(await token.balanceOf(address), swapRate).toDAI();
		balance.onChain.total = getTotal(balance.onChain.ether, balance.onChain.token).toETH();
		balance.channel.ether = Currency.WEI(freeEtherBalance[freeBalanceAddress], swapRate).toETH();
		balance.channel.token = Currency.DEI(freeTokenBalance[freeBalanceAddress], swapRate).toDAI();
		balance.channel.total = getTotal(balance.channel.ether, balance.channel.token).toETH();
		this.setState({ balance });
	}

	async setDepositLimits() {
		const { swapRate, ethprovider } = this.state;
		let gasPrice = await ethprovider.getGasPrice();
		let totalDepositGasWei = DEPOSIT_ESTIMATED_GAS.mul(toBN(2)).mul(gasPrice);
		let totalWithdrawalGasWei = WITHDRAW_ESTIMATED_GAS.mul(gasPrice);
		const minDeposit = Currency.WEI(totalDepositGasWei.add(totalWithdrawalGasWei), swapRate).toETH();
		const maxDeposit = MAX_CHANNEL_VALUE.toETH(swapRate); // Or get based on payment profile?
		this.setState({ maxDeposit, minDeposit });
	}

	async autoDeposit() {
		const { balance, channel, minDeposit, maxDeposit, pending, swapRate, token } = this.state;
		if (!channel || !(await channel.getChannel()).available) {
			console.warn(`Channel not available yet.`);
			return;
		}
		if (balance.onChain.ether.wad.eq(Zero)) {
			console.debug(`No on-chain eth to deposit`)
			return;
		}
		if (!pending.complete) {
			console.log(`An operation of type ${pending.type} is pending, waiting to deposit`)
			return;
		}

		let nowMaxDeposit = maxDeposit.wad.sub(this.state.balance.channel.total.wad);
		if (nowMaxDeposit.lte(Zero)) {
			console.debug(`Channel balance (${balance.channel.total.toDAI().format()}) is at or above ` +
			  `cap of ${maxDeposit.toDAI(swapRate).format()}`)
			return;
		}

		if (balance.onChain.token.wad.gt(Zero)) {
			const amount = minBN([
			  Currency.WEI(nowMaxDeposit, swapRate).toDAI().wad,
			  balance.onChain.token.wad
			]);
			const depositParams = {
			  amount: amount.toString(),
			  assetId: token.address.toLowerCase(),
			};
			const channelState = JSON.stringify(await channel.getChannel(), null, 2);
			console.log(`Depositing ${depositParams.amount} tokens into channel: ${channelState}`);
			this.setPending({ type: "deposit", complete: false, closed: false });
			const result = await channel.deposit(depositParams);
			this.setPending({ type: "deposit", complete: true, closed: false });
			await this.refreshBalances();
			console.log(`Successfully deposited tokens! Result: ${JSON.stringify(result, null, 2)}`);
		} else {
			console.debug(`No tokens to deposit`);
		}

		nowMaxDeposit = maxDeposit.wad.sub(this.state.balance.channel.total.wad);
		if (nowMaxDeposit.lte(Zero)) {
			console.debug(`Channel balance (${balance.channel.total.toDAI().format()}) is at or above ` +
		  `cap of ${maxDeposit.toDAI(swapRate).format()}`)
			return;
		}
		if (balance.onChain.ether.wad.lt(minDeposit.wad)) {
			console.debug(`Not enough on-chain eth to deposit: ${balance.onChain.ether.toETH().format()}`)
			return;
		}

		const amount = minBN([
			balance.onChain.ether.wad.sub(minDeposit.wad),
			nowMaxDeposit,
		]);
		const channelState = JSON.stringify(await channel.getChannel(), null, 2);
		console.log(`Depositing ${amount} wei into channel: ${channelState}`);
		this.setPending({ type: "deposit", complete: false, closed: false });
		const result = await channel.deposit({ amount: amount.toString() });
		this.setPending({ type: "deposit", complete: true, closed: false });
		console.log(`Successfully deposited ether! Result: ${JSON.stringify(result, null, 2)}`);
	}

	async autoSwap() {
		const { balance, channel, maxDeposit, pending, swapRate, token } = this.state;
		if (!channel || !(await channel.getChannel()).available) {
			console.warn(`Channel not available yet.`);
			return;
		}
		if (balance.channel.ether.wad.eq(Zero)) {
			console.debug(`No in-channel eth available to swap`)
			return;
		}
		if (balance.channel.token.wad.gte(maxDeposit.toDAI(swapRate).wad)) {
			return; // swap ceiling has been reached, no need to swap more
		}
		if (!pending.complete) {
			console.log(`An operation of type ${pending.type} is pending, waiting to swap`)
			return;
		}
		const maxSwap = tokenToWei(maxDeposit.toDAI().wad.sub(balance.channel.token.wad), swapRate)
		const weiToSwap = minBN([balance.channel.ether.wad, maxSwap])
		const hubFBAddress = connext.utils.freeBalanceAddressFromXpub(channel.nodePublicIdentifier)
		const collateralNeeded = balance.channel.token.wad.add(weiToToken(weiToSwap, swapRate));
		let collateral = formatEther((await channel.getFreeBalance(token.address))[hubFBAddress])

		console.log(`Collateral: ${collateral} tokens, ${formatEther(collateralNeeded)} needed`);
		if (collateralNeeded.gt(parseEther(collateral))) {
			console.log(`Requesting more collateral...`)
			await channel.addPaymentProfile({
			  amountToCollateralize: collateralNeeded.add(parseEther("10")), // add a buffer of $10 so you dont collateralize on every payment
			  minimumMaintainedCollateral: collateralNeeded,
			  tokenAddress: token.address,
			});
			await channel.requestCollateral(token.address);
			collateral = formatEther((await channel.getFreeBalance(token.address))[hubFBAddress])
			console.log(`Collateral: ${collateral} tokens, ${formatEther(collateralNeeded)} needed`);
			return;
		}

		console.log(`Attempting to swap ${formatEther(weiToSwap)} eth for dai at rate: ${swapRate}`);
		this.setPending({ type: "swap", complete: false, closed: false });
		await channel.swap({
			amount: weiToSwap.toString(),
			fromAssetId: AddressZero,
			swapRate,
			toAssetId: token.address,
		});
		this.setPending({ type: "swap", complete: true, closed: false });
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
	//async withdrawalHandler(withdrawEth) {
		/*const { balance, channel } = this.state
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
		console.log(`Cashout result: ${JSON.stringify(result)}`)*/
		//history.push("/")
	//}

	async withdrawalEther() {
		const { balance, channel, history, swapRate, token } = this.state
		const recipient = this.state.recipient.value
		if (!recipient) return
		const total = balance.channel.total
		if (total.wad.lte(Zero)) return

		// Put lock on actions, no more autoswaps until we're done withdrawing
		this.setPending({ type: "withdrawal", complete: false, closed: false })
		this.setState({ withdrawing: true });
		console.log(`Withdrawing ${total.toETH().format()} to: ${recipient}`);

		// swap all in-channel tokens for eth
		if (balance.channel.token.wad.gt(Zero)) {
		  await channel.addPaymentProfile({
		    amountToCollateralize: total.toETH().wad.toString(),
		    minimumMaintainedCollateral: total.toETH().wad.toString(),
		    tokenAddress: AddressZero,
		  });
		  await channel.requestCollateral(AddressZero);
		  await channel.swap({
		    amount: balance.channel.token.wad.toString(),
		    fromAssetId: token.address,
		    swapRate: inverse(swapRate),
		    toAssetId: AddressZero,
		  });
		  await this.props.refreshBalances()
		}

		const result = await channel.withdraw({
		  amount: balance.channel.ether.wad.toString(),
		  assetId: AddressZero,
		  recipient,
		});
		console.log(`Cashout result: ${JSON.stringify(result)}`)
		this.setState({ withdrawing: false })
		this.setPending({ type: "withdrawal", complete: true, closed: false })
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
					onClick={() => this.withdrawalEther(true)}
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
