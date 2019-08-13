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

const split = (balance) => {
	const bal = balance.format({ decimals: 3, symbol: false });
	const whole = bal.substring(0, bal.indexOf('.'));
	const part = bal.substring(bal.indexOf('.'));
	return { whole, part: part.substring(0,4) };
}

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
	      pending: { type: "null", complete: true, closed: true },
	      sendScanArgs: { amount: null, recipient: null },
	      swapRate,
	      token: null,
	      xpub: "",
	    };
	    this.refreshBalances.bind(this);
	    this.setDepositLimits.bind(this);
	    this.autoDeposit.bind(this);
	    this.autoSwap.bind(this);
	    this.setPending.bind(this);
	    this.closeConfirmations.bind(this);
	}

	// ************************************************* //
    //                     Hooks                         //
    // ************************************************* //

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
	  console.warn(`... autoDeposit ...`);

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

	render() {
		const {
			address,
			balance,
			channel,
			swapRate,
			maxDeposit,
			minDeposit,
			pending,
			sendScanArgs,
			token,
			xpub,
		} = this.state;

		const minEth = minDeposit ? minDeposit.toETH().format() : '?.??'
		const maxEth = maxDeposit ? maxDeposit.toETH().format() : '?.??'
		const maxDai = maxDeposit ? maxDeposit.toDAI().format() : '?.??'

		var depositTo = `Deposit to address: ${address}`
		var depositMaxMin = `maxDeposit=${maxEth} minDeposit=${minEth}`
		var onChannel = `Deposited on Channel: ERC20 = ${split(balance.channel.token.toDAI()).whole}${split(balance.channel.token.toDAI()).part}, ETH = ${split(balance.channel.ether.toETH()).whole}${split(balance.channel.ether.toETH()).part}`

		var onChain = `On-Chain: ERC20 = ${split(balance.onChain.token.toDAI()).whole}${split(balance.onChain.token.toDAI()).part}, ETH = ${split(balance.onChain.ether.toETH()).whole}${split(balance.onChain.ether.toETH()).part}`

		return <div>
			<div>{ onChannel }</div>
			<div>{ onChain }</div>
			<br/>
			<div>{ depositTo }</div>
			<div>{ depositMaxMin }</div>
		</div>
	}


}
export default withStyles(styles)(ConnextView);
