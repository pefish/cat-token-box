/* eslint-disable prettier/prettier */
import {
  int2ByteString,
  MethodCallOptions,
  toByteString,
  UTXO,
} from 'scrypt-ts';
import {
  broadcast,
  btc,
  callToBufferList,
  getDummySigner,
  getDummyUTXO,
  getOpenMinterContractP2TR,
  getRawTransaction,
  logerror,
  OpenMinterContract,
  OpenMinterTokenInfo,
  outpoint2ByteString,
  Postage,
  resetTx,
  TokenMetadata,
  toP2tr,
  toStateScript,
  verifyContract,
} from 'src/common';

import {
  CAT20Proto,
  CAT20State,
  ChangeInfo,
  getBackTraceInfo,
  getTxCtx,
  int32,
  OpenMinter,
  OpenMinterProto,
  OpenMinterState,
  PreTxStatesInfo,
  ProtocolState,
} from '@cat-protocol/cat-smartcontracts';
import { ConfigService, SpendService, WalletService } from 'src/providers';
import { scaleConfig } from 'src/token';

const getPremineAddress = async (
  config: ConfigService,
  wallet: WalletService,
  utxo: UTXO,
): Promise<string | Error> => {
  const txhex = await getRawTransaction(config, wallet, utxo.txId);
  if (txhex instanceof Error) {
    logerror(`get raw transaction ${utxo.txId} failed!`, txhex);
    return txhex;
  }
  try {
    const tx = new btc.Transaction(txhex);
    const witnesses: Buffer[] = tx.inputs[0].getWitnesses();
    const lockingScript = witnesses[witnesses.length - 2];
    const minter = OpenMinter.fromLockingScript(
      lockingScript.toString('hex'),
    ) as OpenMinter;
    return minter.premineAddr;
  } catch (error) {
    return error;
  }
};

const calcVsize = async (
  wallet: WalletService,
  minter: OpenMinter,
  newState: ProtocolState,
  tokenMint: CAT20State,
  splitAmountList: Array<bigint>,
  preTxState: PreTxStatesInfo,
  preState: OpenMinterState,
  minterTapScript: string,
  inputIndex: number,
  revealTx: btc.Transaction,
  changeScript: btc.Script,
  backtraceInfo: any,
  cblockMinter: string,
) => {
  const { shPreimage, prevoutsCtx, spentScripts, sighash } = getTxCtx(
    revealTx,
    inputIndex,
    Buffer.from(minterTapScript, 'hex'),
  );

  const changeInfo: ChangeInfo = {
    script: toByteString(changeScript.toHex()),
    satoshis: int2ByteString(BigInt(0n), 8n),
  };
  const sig = btc.crypto.Schnorr.sign(
    wallet.getTokenPrivateKey(),
    sighash.hash,
  );
  const minterCall = await minter.methods.mint(
    newState.stateHashList,
    tokenMint,
    splitAmountList,
    wallet.getPubKeyPrefix(),
    wallet.getXOnlyPublicKey(),
    () => sig.toString('hex'),
    int2ByteString(BigInt(Postage.MINTER_POSTAGE), 8n),
    int2ByteString(BigInt(Postage.TOKEN_POSTAGE), 8n),
    preState,
    preTxState,
    backtraceInfo,
    shPreimage,
    prevoutsCtx,
    spentScripts,
    changeInfo,
    {
      fromUTXO: getDummyUTXO(),
      verify: false,
      exec: false,
    } as MethodCallOptions<OpenMinter>,
  );
  const witnesses = [
    ...callToBufferList(minterCall),
    minter.lockingScript.toBuffer(),
    Buffer.from(cblockMinter, 'hex'),
  ];
  revealTx.inputs[inputIndex].witnesses = witnesses;
  wallet.signTx(revealTx);
  const vsize = revealTx.vsize;
  resetTx(revealTx);
  return vsize;
};

export function createOpenMinterState(
  mintAmount: int32,
  isPriemined: boolean,
  remainingSupply: int32,
  metadata: TokenMetadata,
  newMinter: number,
): {
  splitAmountList: bigint[];
  minterStates: OpenMinterState[];
} {
  console.log(`token metadata: ${JSON.stringify(metadata, null, 2)}`);
  const scaledInfo = scaleConfig(metadata.info as OpenMinterTokenInfo);

  const premine = !isPriemined ? scaledInfo.premine : 0n;
  const limit = scaledInfo.limit;
  console.log(
    `premine: ${premine}, remainingSupply: ${remainingSupply}, mintAmount: ${mintAmount}`,
  );
  const splitAmountList = OpenMinterProto.getSplitAmountList(
    premine + remainingSupply,
    mintAmount,
    limit,
    newMinter,
  );

  const tokenP2TR = toP2tr(metadata.tokenAddr);

  const minterStates: Array<OpenMinterState> = [];
  for (let i = 0; i < splitAmountList.length; i++) {
    const amount = splitAmountList[i];
    if (amount > 0n) {
      const minterState = OpenMinterProto.create(tokenP2TR, true, amount);
      minterStates.push(minterState);
    }
  }

  return { splitAmountList, minterStates };
}

export async function openMint(
  config: ConfigService,
  wallet: WalletService,
  spendService: SpendService,
  feeRate: number,
  feeUtxos: UTXO[],
  metadata: TokenMetadata,
  newMinter: number /* number of new minter utxo */,
  minterContract: OpenMinterContract,
  mintAmount: bigint,
): Promise<{
  txidOrError: string | Error;
  minterOutputs?: btc.Transaction.Output[];
}> {
  const {
    utxo: minterUtxo,
    state: { protocolState, data: preState },
  } = minterContract;

  const address = wallet.getAddress();

  const tokenReceiver = wallet.getTokenAddress();

  const tokenInfo = metadata.info as OpenMinterTokenInfo;

  const scaledInfo = scaleConfig(tokenInfo);

  const tokenP2TR = btc.Script.fromAddress(metadata.tokenAddr).toHex();

  const genesisId = outpoint2ByteString(metadata.tokenId);

  console.log(`preState: ${JSON.stringify(preState, null, 2)}`);
  const newState = ProtocolState.getEmptyState();
  const { splitAmountList, minterStates } = createOpenMinterState(
    mintAmount,
    preState.isPremined,
    preState.remainingSupply, // minter 中写的
    metadata,
    newMinter,
  );
  console.log(`splitAmountList: ${JSON.stringify(splitAmountList, null, 2)}`);

  for (let i = 0; i < minterStates.length; i++) {
    const minterState = minterStates[i];
    newState.updateDataList(i, OpenMinterProto.toByteString(minterState));
  }

  const tokenState = CAT20Proto.create(mintAmount, tokenReceiver);

  newState.updateDataList(
    minterStates.length,
    CAT20Proto.toByteString(tokenState),
  );

  let premineAddress =
    !preState.isPremined && scaledInfo.premine > 0n
      ? wallet.getTokenAddress()
      : scaledInfo.premine === 0n
        ? ''
        : null;

  if (premineAddress === null) {
    const address = await getPremineAddress(
      config,
      wallet,
      minterContract.utxo,
    );

    if (address instanceof Error) {
      logerror(`get premine address failed!`, address);
      return {
        txidOrError: address,
      };
    }

    premineAddress = address;
  }

  const {
    tapScript: minterTapScript,
    cblock: cblockToken,
    contract: minter,
  } = getOpenMinterContractP2TR(
    genesisId,
    scaledInfo.max,
    scaledInfo.premine,
    scaledInfo.limit,
    premineAddress,
  );

  const changeScript = btc.Script.fromAddress(address);

  const utxos = [minterUtxo, ...feeUtxos];
  console.log(`utxos length: ${utxos.length}`);
  console.log(`minterUtxo: ${JSON.stringify(minterUtxo, null, 2)}`);
  console.log(`feeUtxos: ${JSON.stringify(feeUtxos, null, 2)}`);
  console.log(`newState: ${JSON.stringify(newState, null, 2)}`);
  const revealTx = new btc.Transaction()
    .from(utxos)
    .addOutput(
      new btc.Transaction.Output({
        satoshis: 0,
        script: toStateScript(newState),
      }),
    )
    .enableRBF();

  const minterOutputs: btc.Transaction.Output[] = [];
  for (let i = 0; i < splitAmountList.length; i++) {
    if (splitAmountList[i] > 0n) {
      const mintOutput = new btc.Transaction.Output({
        script: new btc.Script(minterUtxo.script),
        satoshis: Postage.MINTER_POSTAGE,
      });
      minterOutputs.push(mintOutput);
      revealTx.addOutput(mintOutput);
    }
  }

  revealTx
    .addOutput(
      new btc.Transaction.Output({
        satoshis: Postage.TOKEN_POSTAGE,
        script: tokenP2TR,
      }),
    )
    .addOutput(
      new btc.Transaction.Output({
        satoshis: 0,
        script: changeScript,
      }),
    )
    .feePerByte(feeRate);

  const minterInputIndex = 0;

  const commitTxHex = await getRawTransaction(config, wallet, minterUtxo.txId);
  if (commitTxHex instanceof Error) {
    logerror(`get raw transaction ${minterUtxo.txId} failed!`, commitTxHex);
    return {
      txidOrError: commitTxHex,
      minterOutputs: minterOutputs,
    };
  }

  const commitTx = new btc.Transaction(commitTxHex);

  const prevPrevTxId =
    commitTx.inputs[minterInputIndex].prevTxId.toString('hex');
  const prevPrevTxHex = await getRawTransaction(config, wallet, prevPrevTxId);
  if (prevPrevTxHex instanceof Error) {
    logerror(`get raw transaction ${prevPrevTxId} failed!`, prevPrevTxHex);
    return {
      txidOrError: prevPrevTxHex,
      minterOutputs: minterOutputs,
    };
  }

  const prevPrevTx = new btc.Transaction(prevPrevTxHex);

  const backtraceInfo = getBackTraceInfo(
    commitTx,
    prevPrevTx,
    minterInputIndex,
  );

  await minter.connect(getDummySigner());

  const preTxState: PreTxStatesInfo = {
    statesHashRoot: protocolState.hashRoot,
    txoStateHashes: protocolState.stateHashList,
  };

  const vsize: number = await calcVsize(
    wallet,
    minter as OpenMinter,
    newState,
    tokenState,
    splitAmountList,
    preTxState,
    preState,
    minterTapScript,
    minterInputIndex,
    revealTx,
    changeScript,
    backtraceInfo,
    cblockToken,
  );

  const changeAmount =
    revealTx.inputAmount -
    vsize * feeRate -
    Postage.MINTER_POSTAGE * newMinter -
    Postage.TOKEN_POSTAGE;

  if (changeAmount < 546) {
    const message = 'Insufficient satoshis balance!';
    return {
      txidOrError: new Error(message),
      minterOutputs: minterOutputs,
    };
  }

  // update change amount
  const changeOutputIndex = revealTx.outputs.length - 1;
  revealTx.outputs[changeOutputIndex].satoshis = changeAmount;

  const { shPreimage, prevoutsCtx, spentScripts, sighash } = getTxCtx(
    revealTx,
    minterInputIndex,
    Buffer.from(minterTapScript, 'hex'),
  );

  const changeInfo: ChangeInfo = {
    script: toByteString(changeScript.toHex()),
    satoshis: int2ByteString(BigInt(changeAmount), 8n),
  };

  console.log(`to sign...`);
  const sig = btc.crypto.Schnorr.sign(
    wallet.getTokenPrivateKey(),
    sighash.hash,
  );

  const minterCall = await minter.methods.mint(
    newState.stateHashList,
    tokenState,
    splitAmountList,
    wallet.getPubKeyPrefix(),
    wallet.getXOnlyPublicKey(),
    () => sig.toString('hex'),
    int2ByteString(BigInt(Postage.MINTER_POSTAGE), 8n),
    int2ByteString(BigInt(Postage.TOKEN_POSTAGE), 8n),
    preState,
    preTxState,
    backtraceInfo,
    shPreimage,
    prevoutsCtx,
    spentScripts,
    changeInfo,
    {
      fromUTXO: getDummyUTXO(),
      verify: false,
      exec: false,
    } as MethodCallOptions<OpenMinter>,
  );
  const witnesses = [
    ...callToBufferList(minterCall),
    minter.lockingScript.toBuffer(),
    Buffer.from(cblockToken, 'hex'),
  ];
  revealTx.inputs[minterInputIndex].witnesses = witnesses;

  if (config.getVerify()) {
    const res = verifyContract(
      minterUtxo,
      revealTx,
      minterInputIndex,
      witnesses,
    );
    if (typeof res === 'string') {
      console.log('unlocking minter failed:', res);
      return {
        txidOrError: new Error('unlocking minter failed'),
        minterOutputs: minterOutputs,
      };
    }
  }

  wallet.signTx(revealTx);
  console.log(`to broadcast...`);
  const res = await broadcast(config, wallet, revealTx.uncheckedSerialize());

  if (res instanceof Error) {
    //logerror('broadcast tx failed!', res);
    return {
      txidOrError: res,
      minterOutputs: minterOutputs,
    };
  }
  spendService.updateSpends(revealTx);
  return {
    txidOrError: res,
    minterOutputs: minterOutputs,
  };
}
