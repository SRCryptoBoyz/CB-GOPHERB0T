import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { SigningStargateClient, StargateClient, coins } from "@cosmjs/stargate";

const GOPHER_RPC_URL = "https://rpc-gopher-testnet-validator.dev.masalabs.ai/";
const GOPHER_CHAIN_ID = "gopher-testnet";
const VALIDATOR_ADDRESS = "gophervaloper1smqe67yyzwluucgf4chdta22gnl7ye7na3u63d";
const DENOM = "ugoai";
const BECH32_PREFIX = "gopher";
const CONFIG_FILE = "config.json";
const isDebug = false;

const directions = [
  { chain: "gopher", rpc: GOPHER_RPC_URL, chainId: GOPHER_CHAIN_ID }
];

let walletInfo = {
  address: "N/A",
  balanceGOAI: "0.0000",
  activeAccount: "N/A"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let accounts = [];
let proxies = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  stakeRepetitions: 1,
  goaiStakeRange: { min: 1, max: 2 },
  loopHours: 24
};

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
];

const Headers = {
  'accept': 'application/json, text/plain, */*',
  'content-type': 'application/json',
  'origin': 'https://hub.gopher-ai.com',
  'referer': 'https://hub.gopher-ai.com/'
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.stakeRepetitions = Number(config.stakeRepetitions) || 1;
      dailyActivityConfig.goaiStakeRange.min = Number(config.goaiStakeRange?.min) || 1;
      dailyActivityConfig.goaiStakeRange.max = Number(config.goaiStakeRange?.max) || 2;
      dailyActivityConfig.loopHours = Number(config.loopHours) || 24;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

async function makeApiCall(url, method, data, proxyUrl) {
  try {
    const headers = { ...Headers, 'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)] };
    const agent = createAgent(proxyUrl);
    if (isDebug) {
      addLog(`Debug: Sending API request to ${url} with payload: ${JSON.stringify(data, null, 2)}`, "debug");
    }
    const response = await axios({ method, url, data, headers, httpsAgent: agent });
    if (isDebug) {
      addLog(`Debug: API response from ${url}: ${JSON.stringify(response.data, null, 2)}`, "debug");
    }
    return response.data;
  } catch (error) {
    addLog(`API call failed (${url}): ${error.message}`, "error");
    if (error.response) {
      addLog(`Debug: Error response: ${JSON.stringify(error.response.data, null, 2)}`, "debug");
    }
    throw error;
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason.message || reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.redBright(message);
      break;
    case "success":
      coloredMessage = chalk.greenBright(message);
      break;
    case "warn":
      coloredMessage = chalk.magentaBright(message);
      break;
    case "wait":
      coloredMessage = chalk.yellowBright(message);
      break;
    case "info":
      coloredMessage = chalk.whiteBright(message);
      break;
    case "delay":
      coloredMessage = chalk.cyanBright(message);
      break;
    case "debug":
      coloredMessage = chalk.blueBright(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

async function loadAccounts() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    const privateKeys = data.split("\n").map(line => line.trim()).filter(line => line);
    accounts = await Promise.all(privateKeys.map(async (privateKeyHex) => {
      const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
      const wallet = await DirectSecp256k1Wallet.fromKey(privateKeyBytes, BECH32_PREFIX);
      const [acc] = await wallet.getAccounts();
      return { privateKey: privateKeyHex, address: acc.address };
    }));
    if (accounts.length === 0) {
      throw new Error("No private keys found in pk.txt");
    }
    addLog(`Loaded ${accounts.length} accounts from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load accounts: ${error.message}`, "error");
    accounts = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

async function getQueryClient() {
  return await StargateClient.connect(GOPHER_RPC_URL);
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process interrupted.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } catch (error) {
    addLog(`Sleep error: ${error.message}`, "error");
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const queryClient = await getQueryClient();
  const walletDataPromises = accounts.map(async (account, i) => {
    try {
      const balance = await queryClient.getBalance(account.address, DENOM);
      const formattedGOAI = (Number(balance.amount) / 1e6).toFixed(6);

      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(account.address))}        ${chalk.bold.cyanBright(formattedGOAI.padEnd(12))}`;

      if (i === selectedWalletIndex) {
        walletInfo.address = account.address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceGOAI = formattedGOAI;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.000000`;
    }
  });
  try {
    const walletData = await Promise.all(walletDataPromises);
    addLog("Wallet data updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Wallet data update failed: ${error.message}`, "error");
    return [];
  }
}

async function performStake(privateKeyHex, amount) {
  const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
  const wallet = await DirectSecp256k1Wallet.fromKey(privateKeyBytes, BECH32_PREFIX);
  const client = await SigningStargateClient.connectWithSigner(GOPHER_RPC_URL, wallet);
  const [acc] = await wallet.getAccounts();
  const address = acc.address;

  const balance = await client.getBalance(address, DENOM);
  const available = Number(balance.amount) / 1e6;
  if (available < amount + 0.01) {
    throw new Error(`Insufficient GOAI balance: ${available} < ${amount} + fee`);
  }

  const amountU = (amount * 1e6).toFixed(0);
  const msg = {
    typeUrl: "/cosmos.staking.v1beta1.MsgDelegate",
    value: {
      delegatorAddress: address,
      validatorAddress: VALIDATOR_ADDRESS,
      amount: { denom: DENOM, amount: amountU },
    },
  };

  const fee = {
    amount: coins(5000, DENOM),
    gas: "200000",
  };

  const memo = "delegate via Bot";

  const result = await client.signAndBroadcast(address, [msg], fee, memo);
  if (result.code !== 0) {
    throw new Error(`Tx failed: ${result.rawLog}`);
  }
  addLog(`Stake ${amount} GOAI Successfully, Hash: ${getShortHash(result.transactionHash)}`, "success");
}

async function runDailyActivity() {
  if (accounts.length === 0) {
    addLog("No valid accounts found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Stake: ${dailyActivityConfig.stakeRepetitions}x`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < accounts.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
      const { privateKey, address } = accounts[accountIndex];
      if (!address.startsWith(BECH32_PREFIX)) {
        addLog(`Invalid wallet address for account ${accountIndex + 1}: ${address}`, "error");
        continue;
      }
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(address)}`, "wait");

      const direction = directions[0];
      for (let stakeCount = 0; stakeCount < dailyActivityConfig.stakeRepetitions && !shouldStop; stakeCount++) {
        let amount = (Math.random() * (dailyActivityConfig.goaiStakeRange.max - dailyActivityConfig.goaiStakeRange.min) + dailyActivityConfig.goaiStakeRange.min).toFixed(4);
        if (amount < 1) amount = 1; 
        addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: ${amount} GOAI`, "warn");
        try {
          await performStake(privateKey, amount);
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: Failed: ${error.message}. Skipping to next.`, "error");
        } finally {
          await updateWallets();
        }
        if (stakeCount < dailyActivityConfig.stakeRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next stake...`, "delay");
          await sleep(randomDelay);
        }
      }

      if (accountIndex < accounts.length - 1 && !shouldStop) {
        addLog(`Waiting 10 seconds before next account...`, "delay");
        await sleep(10000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog(`All accounts processed. Waiting ${dailyActivityConfig.loopHours} hours for next cycle.`, "success");
      dailyActivityInterval = setTimeout(runDailyActivity, dailyActivityConfig.loopHours * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      if (activeProcesses <= 0) {
        if (dailyActivityInterval) {
          clearTimeout(dailyActivityInterval);
          dailyActivityInterval = null;
          addLog("Cleared daily activity interval.", "info");
        }
        activityRunning = false;
        isCycleRunning = false;
        shouldStop = false;
        hasLoggedSleepInterrupt = false;
        activeProcesses = 0;
        addLog("Daily activity stopped successfully.", "success");
        updateMenu();
        updateStatus();
        safeRender();
      } else {
        const stopCheckInterval = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(stopCheckInterval);
            if (dailyActivityInterval) {
              clearTimeout(dailyActivityInterval);
              dailyActivityInterval = null;
              addLog("Cleared daily activity interval.", "info");
            }
            activityRunning = false;
            isCycleRunning = false;
            shouldStop = false;
            hasLoggedSleepInterrupt = false;
            activeProcesses = 0;
            addLog("Daily activity stopped successfully.", "success");
            updateMenu();
            updateStatus();
            safeRender();
          } else {
            addLog(`Waiting for ${activeProcesses} process to complete...`, "info");
          }
        }, 1000);
      }
    } else {
      activityRunning = false;
      isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "GHOPAR TESTNET AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: chalk.cyan(" Status "),
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs",
  top: 9,
  left: "41%",
  width: "59%",
  height: "100%-9",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback: 100,
  smoothScroll: true,
  style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  wrap: true,
  focusable: true,
  keys: true
});

const menuBox = blessed.list({
  label: " Menu ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
  items: isCycleRunning
    ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 }
});

const dailyActivitySubMenu = blessed.list({
  label: " Manual Config Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item: { fg: "white" }
  },
  items: [
    "Set Stake Repetitions",
    "Set GOAI Stake Range",
    "Set Loop Daily",
    "Back to Main Menu"
  ],
  padding: { left: 1, top: 1 },
  hidden: true
});

const configForm = blessed.form({
  label: " Enter Config Value ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Min Value:",
  style: { fg: "white" }
});

const maxLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Max Value:",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(configForm);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("C - BOYZ", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{green-fg}${data}{/green-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;
  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
  statusBox.width = screenWidth - 2;
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = screenWidth - walletBox.width - 2;
  logBox.height = screenHeight - (headerBox.height + statusBox.height);
  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  if (menuBox.top != null) {
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    configForm.width = Math.floor(screenWidth * 0.3);
    configForm.height = Math.floor(screenHeight * 0.4);
  }

  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
    const status = activityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : isCycleRunning && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
      : chalk.green("Idle");
    const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${accounts.length} | Auto Stake: ${dailyActivityConfig.stakeRepetitions}x | Loop: ${dailyActivityConfig.loopHours}h | GHOPAR TESTNET AUTO BOT`;
    statusBox.setContent(statusText);
    if (isProcessing) {
      if (blinkCounter % 1 === 0) {
        statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
        borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
      }
      blinkCounter++;
    } else {
      statusBox.style.border.fg = "green";
    }
    spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
    safeRender();
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
}

async function updateWallets() {
  try {
    const walletData = await updateWalletData();
    const header = `${chalk.bold.cyan("  Address").padEnd(20)}               ${chalk.bold.cyan("GOAI".padEnd(12))}`;
    const separator = chalk.gray("-".repeat(80));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallet data: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
    logBox.scrollTo(transactionLogs.length);
    safeRender();
  } catch (error) {
    addLog(`Log update failed: ${error.message}`, "error");
  }
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
        : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    );
    safeRender();
  } catch (error) {
    addLog(`Menu update failed: ${error.message}`, "error");
  }
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(-1);
    safeRender();
  }
});

logBox.key(["down"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(1);
    safeRender();
  }
});

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  dailyActivitySubMenu.style.border.fg = "blue";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        addLog("Cleared daily activity interval.", "info");
      }
      addLog("Stopping daily activity. Please wait for ongoing process to complete.", "info");
      safeRender();
      if (activeProcesses <= 0) {
        activityRunning = false;
        isCycleRunning = false;
        shouldStop = false;
        hasLoggedSleepInterrupt = false;
        addLog("Daily activity stopped successfully.", "success");
        updateMenu();
        updateStatus();
        safeRender();
      } else {
        const stopCheckInterval = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(stopCheckInterval);
            activityRunning = false;
            isCycleRunning = false;
            shouldStop = false;
            hasLoggedSleepInterrupt = false;
            activeProcesses = 0;
            addLog("Daily activity stopped successfully.", "success");
            updateMenu();
            updateStatus();
            safeRender();
          } else {
            addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
            safeRender();
          }
        }, 1000);
      }
      break;
    case "Set Manual Config":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
});

dailyActivitySubMenu.on("select", (item) => {
  const action = item.getText();
  switch (action) {
    case "Set Stake Repetitions":
      configForm.configType = "stakeRepetitions";
      configForm.setLabel(" Enter Stake Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.stakeRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set GOAI Stake Range":
      configForm.configType = "goaiStakeRange";
      configForm.setLabel(" Enter GOAI Stake Range (Min >=1) ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.goaiStakeRange.min.toString());
      configInputMax.setValue(dailyActivityConfig.goaiStakeRange.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set Loop Daily":
      configForm.configType = "loopHours";
      configForm.setLabel(" Enter Loop Hours (Min 1 Hours) ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.loopHours.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "cyan";
          dailyActivitySubMenu.style.border.fg = "blue";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

let isSubmitting = false;
configForm.on("submit", () => {
  if (isSubmitting) return;
  isSubmitting = true;

  const inputValue = configInput.getValue().trim();
  let value, maxValue;
  try {
    if (configForm.configType === "loopHours" || configForm.configType === "stakeRepetitions") {
      value = parseInt(inputValue);
    } else {
      value = parseFloat(inputValue);
    }
    if (["goaiStakeRange"].includes(configForm.configType)) {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Max value. Please enter a positive number.", "error");
        configInputMax.clearValue();
        screen.focusPush(configInputMax);
        safeRender();
        isSubmitting = false;
        return;
      }
    }
    if (isNaN(value) || value <= 0) {
      addLog("Invalid input. Please enter a positive number.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    if (configForm.configType === "loopHours" && value < 1) {
      addLog("Invalid input. Minimum is 1 hour.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    if (configForm.configType === "goaiStakeRange" && value < 1) {
      addLog("Invalid Min value. Minimum is 1 GOAI.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.clearValue();
    screen.focusPush(configInput);
    safeRender();
    isSubmitting = false;
    return;
  }

  if (configForm.configType === "stakeRepetitions") {
    dailyActivityConfig.stakeRepetitions = Math.floor(value);
    addLog(`Stake Repetitions set to ${dailyActivityConfig.stakeRepetitions}`, "success");
  } else if (configForm.configType === "goaiStakeRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.goaiStakeRange.min = value;
    dailyActivityConfig.goaiStakeRange.max = maxValue;
    addLog(`GOAI Stake Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "loopHours") {
    dailyActivityConfig.loopHours = value;
    addLog(`Loop Daily set to ${value} hours`, "success");
  }
  saveConfig();
  updateStatus();

  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
    isSubmitting = false;
  }, 100);
});

configInput.key(["enter"], () => {
  if (["goaiStakeRange"].includes(configForm.configType)) {
    screen.focusPush(configInputMax);
  } else {
    configForm.submit();
  }
});

configInputMax.key(["enter"], () => {
  configForm.submit();
});

configSubmitButton.on("press", () => {
  configForm.submit();
});

configSubmitButton.on("click", () => {
  screen.focusPush(configSubmitButton);
  configForm.submit();
});

configForm.key(["escape"], () => {
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      dailyActivitySubMenu.style.border.fg = "blue";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  try {
    loadConfig();
    await loadAccounts();
    loadProxies();
    updateStatus();
    await updateWallets();
    updateLogs();
    safeRender();
    menuBox.focus();
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();
