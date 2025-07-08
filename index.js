import blessed from 'blessed';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import cfonts from 'cfonts';
import ProxyChain from 'proxy-chain';

puppeteer.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class NexusMiner {
  constructor(account, id, proxy = null, proxyIp = null) {
    this.account = account;
    this.id = id;
    this.proxy = proxy || 'None';
    this.proxyIp = proxyIp || 'Unknown';
    this.userInfo = {
      address: account.address || '-',
      points: '-',
      ip: 'Unknown',
      proxy: this.proxy,
      ops: 'N/A',
      status: 'Inactive',
    };
    this.isMining = false;
    this.miningInterval = null;
    this.toggleCheckInterval = null;
    this.uiScreen = null;
    this.accountPane = null;
    this.logPane = null;
    this.isDisplayed = false;
    this.logs = [];
    this.browser = null;
    this.page = null;
    this.anonymizedProxy = null;
  }

  async start() {
    this.addLog(chalk.cyan('Starting miner...'));
    if (!(await this.checkConnection())) {
      this.addLog(chalk.yellow('Initial connection check failed. Using direct connection...'));
      this.proxy = 'None';
      this.userInfo.proxy = 'None';
    }
    await this.initPuppeteer();
    await this.loginWithRetry();
    await new Promise(resolve => setTimeout(resolve, 10000));
    await this.fetchUserInfo();
    await this.fetchIpAddress();
    this.refreshDisplay();
    this.addLog(chalk.green('Account Initiallized successfully'));
  }

  async checkConnection(maxRetries = 3) {
    let retries = 0;
    while (retries < maxRetries) {
      try {
        this.addLog(chalk.cyan(`Checking network connection [Attempt ${retries + 1}]...`));
        const config = this.proxy !== 'None' ? { proxy: this.parseProxy(this.proxy) } : {};
        await axios.get('https://app.nexus.xyz/', { ...config, timeout: 20000 });
        this.addLog(chalk.green('Network connection verified'));
        return true;
      } catch (error) {
        retries++;
        this.addLog(chalk.red(`Network connection attempt ${retries} failed: ${error.message}`));
        if (retries === maxRetries) {
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    return false;
  }

  parseProxy(proxy) {
    try {
      const proxyUrl = new URL(proxy);
      return {
        host: proxyUrl.hostname,
        port: parseInt(proxyUrl.port),
        auth: proxyUrl.username && proxyUrl.password ? {
          username: proxyUrl.username,
          password: proxyUrl.password,
        } : undefined,
      };
    } catch (error) {
      this.addLog(chalk.red(`Failed to parse proxy ${proxy}: ${error.message}`));
      return null;
    }
  }

  async initPuppeteer() {
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    };
    if (this.proxy !== 'None') {
      try {
        this.anonymizedProxy = await ProxyChain.anonymizeProxy(this.proxy);
        launchOptions.args.push(`--proxy-server=${this.anonymizedProxy}`);
      } catch (error) {
        this.addLog(chalk.red(`Failed to anonymize proxy ${this.proxy}: ${error.message}`));
        this.proxy = 'None';
        this.userInfo.proxy = 'None';
      }
    }
    try {
      this.browser = await puppeteer.launch(launchOptions);
      this.page = await this.browser.newPage();
      await this.page.setUserAgent(this.getRandomUserAgent());
      await this.page.setViewport({ width: 1280, height: 720 });
      await this.page._client().send('Network.clearBrowserCache');
      await this.page._client().send('Network.clearBrowserCookies');
    } catch (error) {
      this.addLog(chalk.red(`Failed to initialize browser: ${error.message}`));
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      try {
        await this.page._client().send('Network.clearBrowserCache');
        await this.page._client().send('Network.clearBrowserCookies');
        await this.browser.close();
        this.addLog(chalk.yellow('Browser closed'));
      } catch (error) {
        this.addLog(chalk.red(`Failed to close browser: ${error.message}`));
      }
      this.browser = null;
      this.page = null;
    }
    if (this.anonymizedProxy) {
      await ProxyChain.closeAnonymizedProxy(this.anonymizedProxy, true).catch(() => {});
      this.anonymizedProxy = null;
    }
  }

  async loginWithRetry(maxRetries = 3) {
    let retries = 0;
    while (retries < maxRetries) {
      try {
        this.addLog(chalk.cyan('Accessing NEXUS Miner'));
        await this.page.goto('https://app.nexus.xyz/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        const pageContent = await this.page.content();
        if (pageContent.includes('captcha') || pageContent.includes('verify you are not a bot') || pageContent.includes('Access Denied') || pageContent.includes('403 Forbidden')) {
          this.addLog(chalk.red('CAPTCHA or access error detected'));
          await this.page.screenshot({ path: `error-captcha-${this.id}-${Date.now()}.png` });
          throw new Error('CAPTCHA or access error');
        }

        this.addLog(chalk.cyan('Processing Login'));
        await this.page.evaluate((authToken, minAuthToken) => {
          localStorage.setItem('dynamic_authentication_token', authToken);
          localStorage.setItem('dynamic_min_authentication_token', minAuthToken);
        }, this.account.auth_token, this.account.min_auth_token);
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        const loginSuccess = await Promise.race([
          this.page.waitForSelector('#balance-display span', { timeout: 30000 }).then(() => true),
          this.page.waitForSelector('#connect-toggle-button', { timeout: 30000 }).then(() => true),
        ]).catch(() => false);

        if (!loginSuccess) {
          this.addLog(chalk.red('No Dashboard elements found'));
          await this.page.screenshot({ path: `error-dashboard-${this.id}-${Date.now()}.png` });
          throw new Error('No dashboard elements found');
        }

        this.addLog(chalk.green('Login Successfully'));
        return;
      } catch (error) {
        retries++;
        this.addLog(chalk.red(`Login attempt ${retries} failed: ${error.message}`));
        if (retries === maxRetries) {
          this.addLog(chalk.red('Max login retries reached. Please check token validity or network connection.'));
          await this.page.screenshot({ path: `error-login-${this.id}-${Date.now()}.png` });
          throw new Error('Login failed after maximum retries');
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  async fetchUserInfo(maxRetries = 4) {
    let retries = 0;
    while (retries < maxRetries) {
      try {
        this.addLog(chalk.cyan('Fetching user points...'));
        await this.page.goto('https://app.nexus.xyz/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 6000));
        const pointsSelectors = ['#balance-display span', '.balance-display', '[data-testid="balance"]'];
        let points = '-';
        for (const selector of pointsSelectors) {
          try {
            points = await this.page.$eval(selector, el => el.textContent.trim());
            if (points) break;
          } catch {}
        }
        if (points === '-') {
          throw new Error('Points data Not Found');
        }
        this.userInfo.points = points;
        this.addLog(chalk.green(`User Points Fetched successfully`));
        this.refreshDisplay();
        return;
      } catch (error) {
        retries++;
        this.addLog(chalk.red(`Fetch points attempt ${retries} failed: ${error.message}`));
        if (retries === maxRetries) {
          this.addLog(chalk.red('Max retries reached for fetching points. Points set to "-".'));
          this.userInfo.points = '-';
          await this.page.screenshot({ path: `error-fetchpoints-${this.id}-${Date.now()}.png` });
          this.refreshDisplay();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  async fetchIpAddress() {
    if (this.proxy !== 'None') {
      try {
        const config = { proxy: this.parseProxy(this.proxy) };
        const response = await axios.get('https://api.ipify.org?format=json', { ...config, timeout: 20000 });
        this.userInfo.ip = response.data.ip || this.proxyIp || 'Unknown';
        this.refreshDisplay();
        return;
      } catch (error) {
        this.addLog(chalk.red(`Failed to fetch IP with proxy: ${error.message}`));
      }
    }
    try {
      const response = await axios.get('https://api.ipify.org?format=json', { timeout: 20000 });
      this.userInfo.ip = response.data.ip || 'Unknown';
      this.refreshDisplay();
    } catch (error) {
      this.userInfo.ip = 'Unknown';
      this.addLog(chalk.red(`Failed to fetch IP without proxy: ${error.message}`));
      this.refreshDisplay();
    }
  }

  async refreshAccount() {
    this.addLog(chalk.cyan('Refreshing account...'));
    try {
      await this.stopMining(); 
      await this.closeBrowser(); 
      await this.initPuppeteer(); 
      await this.loginWithRetry(); 
      await new Promise(resolve => setTimeout(resolve, 10000));
      await this.fetchUserInfo(); 
      await this.fetchIpAddress(); 
      this.refreshDisplay(); 
      this.addLog(chalk.green('Account refreshed successfully'));
    } catch (error) {
      this.addLog(chalk.red(`Failed to refresh account: ${error.message}`));
    }
  }

  async startMining() {
    if (this.isMining) {
      this.addLog(chalk.yellow('Mining already active'));
      return;
    }
    this.addLog(chalk.cyan('Activating Mining Proccess...'));
    let retries = 0;
    const maxRetries = 3;
    let toggleFound = false;

    while (retries < maxRetries && !toggleFound) {
      try {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const toggleStatus = await this.page.evaluate(() => {
          let toggle = document.querySelector('#connect-toggle-button');
          if (toggle) {
            const isOff = toggle.classList.contains('border-[#79747E]');
            if (isOff) toggle.click();
            return { found: true, wasOff: isOff, location: 'main DOM' };
          }

          const iframes = document.querySelectorAll('iframe');
          for (let frame of iframes) {
            toggle = frame.contentDocument?.querySelector('#connect-toggle-button');
            if (toggle) {
              const isOff = toggle.classList.contains('border-[#79747E]');
              if (isOff) toggle.click();
              return { found: true, wasOff: isOff, location: 'iframe' };
            }
          }

          const shadowHosts = document.querySelectorAll('*');
          for (let host of shadowHosts) {
            if (host.shadowRoot) {
              toggle = host.shadowRoot.querySelector('#connect-toggle-button');
              if (toggle) {
                const isOff = toggle.classList.contains('border-[#79747E]');
                if (isOff) toggle.click();
                return { found: true, wasOff: isOff, location: 'shadow DOM' };
              }
            }
          }

          return { found: false, message: 'Toggle button not found' };
        });

        if (!toggleStatus.found) {
          throw new Error(toggleStatus.message);
        }

        toggleFound = true;
        await new Promise(resolve => setTimeout(resolve, 1000));
        this.addLog(toggleStatus.wasOff ? chalk.green(`Mining Activated Successfully `) : chalk.cyan(`Mining Already Active`));
        this.isMining = true;
        this.userInfo.status = 'Active';
        this.refreshDisplay();

        this.toggleCheckInterval = setInterval(async () => {
          try {
            const toggleStatus = await this.page.evaluate(() => {
              let toggle = document.querySelector('#connect-toggle-button');
              if (toggle) {
                const isOff = toggle.classList.contains('border-[#79747E]');
                if (isOff) toggle.click();
                return { found: true, wasOff: isOff, location: 'main DOM' };
              }

              const iframes = document.querySelectorAll('iframe');
              for (let frame of iframes) {
                toggle = frame.contentDocument?.querySelector('#connect-toggle-button');
                if (toggle) {
                  const isOff = toggle.classList.contains('border-[#79747E]');
                  if (isOff) toggle.click();
                  return { found: true, wasOff: isOff, location: 'iframe' };
                }
              }

              const shadowHosts = document.querySelectorAll('*');
              for (let host of shadowHosts) {
                if (host.shadowRoot) {
                  toggle = host.shadowRoot.querySelector('#connect-toggle-button');
                  if (toggle) {
                    const isOff = toggle.classList.contains('border-[#79747E]');
                    if (isOff) toggle.click();
                    return { found: true, wasOff: isOff, location: 'shadow DOM' };
                  }
                }
              }

              return { found: false, message: 'Toggle button not found during check' };
            });

            if (!toggleStatus.found) {
              this.addLog(chalk.red(`Mining check failed: ${toggleStatus.message}`));
              this.isMining = false;
              this.userInfo.status = 'Inactive';
              this.refreshDisplay();
              return;
            }
            if (toggleStatus.wasOff) {
              this.addLog(chalk.yellow(`Mining Stoped, Try Reactivated Mining `));
              this.userInfo.status = 'Active';
              this.refreshDisplay();
            }
          } catch (error) {
            this.addLog(chalk.red(`Failed to check mining status: ${error.message}`));
            this.isMining = false;
            this.userInfo.status = 'Inactive';
            this.refreshDisplay();
          }
        }, 300000);

        this.miningInterval = setInterval(async () => {
          await this.updateOps();
          await this.updatePoints();
        }, 5000);

        this.addLog(chalk.green('Mining started'));
      } catch (error) {
        retries++;
        this.addLog(chalk.red(`Start mining attempt ${retries} failed: ${error.message}`));
        if (retries === maxRetries) {
          this.addLog(chalk.red('Max retries reached for start mining.'));
          this.userInfo.status = 'Inactive';
          this.refreshDisplay();
          return;
        }
      }
    }
  }

  async stopMining() {
    if (!this.isMining) {
      this.addLog(chalk.yellow('Mining not active'));
      return;
    }
    this.addLog(chalk.cyan('Stopping Mining Proccess...'));
    try {
      const toggleStatus = await this.page.evaluate(() => {
        let toggle = document.querySelector('#connect-toggle-button');
        if (toggle) {
          const isOn = !toggle.classList.contains('border-[#79747E]');
          if (isOn) toggle.click();
          return { found: true, wasOn: isOn, location: 'main DOM' };
        }

        const iframes = document.querySelectorAll('iframe');
        for (let frame of iframes) {
          toggle = frame.contentDocument?.querySelector('#connect-toggle-button');
          if (toggle) {
            const isOn = !toggle.classList.contains('border-[#79747E]');
            if (isOn) toggle.click();
            return { found: true, wasOn: isOn, location: 'iframe' };
          }
        }

        const shadowHosts = document.querySelectorAll('*');
        for (let host of shadowHosts) {
          if (host.shadowRoot) {
            toggle = host.shadowRoot.querySelector('#connect-toggle-button');
            if (toggle) {
              const isOn = !toggle.classList.contains('border-[#79747E]');
              if (isOn) toggle.click();
              return { found: true, wasOn: isOn, location: 'shadow DOM' };
            }
          }
        }

        return { found: false, message: 'Toggle button not found' };
      });

      if (!toggleStatus.found) {
        throw new Error(toggleStatus.message);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      this.addLog(toggleStatus.wasOn ? chalk.green(`Mining Stopped Successfully`) : chalk.cyan(`Mining Already Stopped `));
      this.isMining = false;
      this.userInfo.status = 'Inactive';
      if (this.miningInterval) {
        clearInterval(this.miningInterval);
        this.miningInterval = null;
      }
      if (this.toggleCheckInterval) {
        clearInterval(this.toggleCheckInterval);
        this.toggleCheckInterval = null;
      }
      this.userInfo.ops = 'N/A';
      this.refreshDisplay();
      this.addLog(chalk.yellow('Mining stopped'));
    } catch (error) {
      this.addLog(chalk.red(`Failed to stop mining: ${error.message}`));
      this.isMining = false;
      this.userInfo.status = 'Inactive';
      this.refreshDisplay();
    }
  }

  async isToggleOn() {
    try {
      const toggleStatus = await this.page.evaluate(() => {
        let toggle = document.querySelector('#connect-toggle-button');
        if (toggle) {
          return { isOn: !toggle.classList.contains('border-[#79747E]'), location: 'main DOM' };
        }

        const iframes = document.querySelectorAll('iframe');
        for (let frame of iframes) {
          toggle = frame.contentDocument?.querySelector('#connect-toggle-button');
          if (toggle) {
            return { isOn: !toggle.classList.contains('border-[#79747E]'), location: 'iframe' };
          }
        }

        const shadowHosts = document.querySelectorAll('*');
        for (let host of shadowHosts) {
          if (host.shadowRoot) {
            toggle = host.shadowRoot.querySelector('#connect-toggle-button');
            if (toggle) {
              return { isOn: !toggle.classList.contains('border-[#79747E]'), location: 'shadow DOM' };
            }
          }
        }

        return { isOn: false, location: 'not found' };
      });
      this.userInfo.status = toggleStatus.isOn ? 'Active' : 'Inactive';
      this.refreshDisplay();
      return toggleStatus.isOn;
    } catch (error) {
      this.addLog(chalk.red(`Failed to check toggle status: ${error.message}`));
      this.userInfo.status = 'Inactive';
      this.refreshDisplay();
      return false;
    }
  }

  async updateOps() {
    try {
      const ops = await this.page.$eval('#speed-display', el => el.textContent.trim());
      this.userInfo.ops = ops;
      this.refreshDisplay();
    } catch (error) {
      this.userInfo.ops = 'N/A';
      this.refreshDisplay();
    }
  }

  async updatePoints() {
    try {
      const pointsSelectors = ['#balance-display span', '.balance-display', '[data-testid="balance"]'];
      let points = '-';
      for (const selector of pointsSelectors) {
        try {
          points = await this.page.$eval(selector, el => el.textContent.trim());
          if (points) break;
        } catch {}
      }
      this.userInfo.points = points !== '-' ? points : '-';
      this.refreshDisplay();
    } catch (error) {
    }
  }

  clearLogs() {
    this.logs = [];
    this.logPane.setContent('');
    this.uiScreen.render();
    this.addLog(chalk.yellow('Logs cleared'));
  }

  getRandomUserAgent() {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  addLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] [Account ${this.id}] ${message.replace(/\{[^}]+\}/g, '')}`;
    this.logs.push(logMessage);
    if (this.logs.length > 100) this.logs.shift();
    if (this.logPane && this.isDisplayed) {
      this.logPane.setContent(this.logs.join('\n'));
      this.logPane.setScrollPerc(100);
      this.uiScreen.render();
    }
  }

  refreshDisplay() {
    if (!this.isDisplayed || !this.accountPane || !this.logPane) return;
    let info = '\n' +
      ' Address       : {magenta-fg}' + this.userInfo.address + '{/magenta-fg}\n' +
      ' Points        : {green-fg}' + this.userInfo.points + '{/green-fg}\n' +
      ' Ops/S         : {green-fg}' + this.userInfo.ops + '{/green-fg}\n' +
      ' IP Address    : {cyan-fg}' + this.userInfo.ip + '{/cyan-fg}\n' +
      ' Proxy         : {cyan-fg}' + this.userInfo.proxy + '{/cyan-fg}\n' +
      ' Status        : {yellow-fg}' + this.userInfo.status + '{/yellow-fg}\n';
    this.accountPane.setContent(info);
    this.logPane.setContent(this.logs.join('\n'));
    this.logPane.setScrollPerc(100);
    this.uiScreen.render();
  }

  static async loadAccounts() {
    try {
      const filePath = path.join(__dirname, 'account.json');
      const data = await fs.readFile(filePath, 'utf8');
      const accounts = JSON.parse(data);
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error('account.json is empty or not an array');
      }
      for (const account of accounts) {
        if (!account.address || !account.auth_token || !account.min_auth_token) {
          throw new Error('Each account in account.json must have address, auth_token, and min_auth_token');
        }
      }
      return accounts.map((account, index) => ({ id: index + 1, ...account }));
    } catch (error) {
      throw new Error('Failed to load account.json: ' + error.message);
    }
  }

  static async loadProxies(miner) {
    try {
      const proxyData = await fs.readFile(path.join(__dirname, 'proxy.txt'), 'utf8');
      const proxyList = proxyData.split('\n').map(line => line.trim()).filter(Boolean);
      miner.addLog(chalk.cyan(`Loaded proxies from proxy.txt: ${JSON.stringify(proxyList)}`));
      const localIP = await this.getLocalIP(miner);
      const validProxies = [];
      const proxyIPs = {};
      for (const proxy of proxyList) {
        const result = await this.validateProxy(proxy, localIP, miner);
        miner.addLog(chalk.cyan(`Validating proxy ${proxy}: ${result.valid ? 'Valid' : 'Invalid'}, IP: ${result.ip || 'N/A'}`));
        if (result.valid) {
          validProxies.push(proxy);
          proxyIPs[proxy] = result.ip;
        } else {
          miner.addLog(chalk.yellow(`Proxy ${proxy} is invalid, but will try to use it for Puppeteer`));
          validProxies.push(proxy);
          proxyIPs[proxy] = result.ip || 'Unknown';
        }
      }
      miner.addLog(chalk.cyan(`Valid proxies for Puppeteer: ${JSON.stringify(validProxies)}`));
      return { proxyList: validProxies, proxyIPs };
    } catch (error) {
      miner.addLog(chalk.red(`Failed to load proxy.txt: ${error.message}`));
      return { proxyList: [], proxyIPs: {} };
    }
  }

  static async getLocalIP(miner) {
    try {
      const response = await axios.get('https://api.ipify.org?format=json', { timeout: 20000 });
      miner.addLog(chalk.cyan(`Local IP fetched: ${response.data.ip}`));
      return response.data.ip;
    } catch (error) {
      miner.addLog(chalk.red(`Failed to fetch local IP: ${error.message}`));
      return 'Unknown';
    }
  }

  static async validateProxy(proxy, localIP, miner) {
    try {
      const proxyUrl = new URL(proxy);
      const proxyConfig = {
        host: proxyUrl.hostname,
        port: parseInt(proxyUrl.port),
        auth: proxyUrl.username && proxyUrl.password ? {
          username: proxyUrl.username,
          password: proxyUrl.password,
        } : undefined,
      };
      const response = await axios.get('https://api.ipify.org?format=json', { proxy: proxyConfig, timeout: 20000 });
      const ip = response.data.ip;
      miner.addLog(chalk.cyan(`Proxy ${proxy} tested, IP: ${ip}`));
      return { valid: ip && ip !== localIP, ip };
    } catch (error) {
      miner.addLog(chalk.red(`Proxy validation failed for ${proxy}: ${error.message}`));
      return { valid: false, ip: null };
    }
  }
}

async function main() {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Nexus Auto Mining',
  });

  const headerPane = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 7,
    tags: true,
    align: 'left',
  });
  screen.append(headerPane);

  function renderBanner() {
    const threshold = 80;
    const margin = Math.max(screen.width - 80, 0);
    let art = '';
    if (screen.width >= threshold) {
      art = cfonts.render('NT EXHAUST', {
        font: 'block',
        align: 'center',
        colors: ['cyan', 'magenta'],
        background: 'transparent',
        letterSpacing: 1,
        lineHeight: 1,
        space: true,
        maxLength: screen.width - margin,
      }).string;
    } else {
      art = cfonts.render('NT EXHAUST', {
        font: 'tiny',
        align: 'center',
        colors: ['cyan', 'magenta'],
        background: 'transparent',
        letterSpacing: 1,
        lineHeight: 1,
        space: true,
        maxLength: screen.width - margin,
      }).string;
    }
    headerPane.setContent(art + '\n');
    headerPane.height = Math.min(8, art.split('\n').length + 2);
  }
  renderBanner();

  const channelPane2 = blessed.box({
    top: '28%',
    left: 2,
    width: '100%',
    height: 2,
    tags: false,
    align: 'center',
  });
  channelPane2.setContent('✪ BOT NEXUS AUTO MINING [BETA v1.0] ✪');
  screen.append(channelPane2);

  const infoPane = blessed.box({
    bottom: 0,
    left: 'center',
    width: '100%',
    height: 2,
    tags: true,
    align: 'center',
  });
  screen.append(infoPane);

  const dashTop = headerPane.height + channelPane2.height;
  const accountPane = blessed.box({
    top: dashTop,
    left: 0,
    width: '50%',
    height: '60%',
    border: { type: 'line' },
    label: ' User Info ',
    tags: true,
    style: { border: { fg: 'cyan' }, fg: 'white', bg: 'default' },
  });
  screen.append(accountPane);

  const logPane = blessed.log({
    top: dashTop,
    left: '50%',
    width: '50%',
    height: '60%',
    border: { type: 'line' },
    label: ' System Logs ',
    tags: true,
    style: { border: { fg: 'magenta' }, fg: 'white', bg: 'default' },
    scrollable: true,
    scrollbar: { bg: 'blue', fg: 'white' },
    alwaysScroll: true,
    mouse: true,
    keys: true,
  });
  screen.append(logPane);

  logPane.on('keypress', (ch, key) => {
    if (key.name === 'up') {
      logPane.scroll(-1);
      screen.render();
    } else if (key.name === 'down') {
      logPane.scroll(1);
      screen.render();
    } else if (key.name === 'pageup') {
      logPane.scroll(-10);
      screen.render();
    } else if (key.name === 'pagedown') {
      logPane.scroll(10);
      screen.render();
    }
  });

  logPane.on('mouse', (data) => {
    if (data.action === 'wheelup') {
      logPane.scroll(-2);
      screen.render();
    } else if (data.action === 'wheeldown') {
      logPane.scroll(2);
      screen.render();
    }
  });

  let accounts = [];
  try {
    accounts = await NexusMiner.loadAccounts();
  } catch (error) {
    logPane.setContent(`Failed to load accounts: ${error.message}\nPress "q" or Ctrl+C to exit.`);
    screen.render();
    screen.key(['escape', 'q', 'C-c'], () => {
      screen.destroy();
      process.exit(0);
    });
    return;
  }

  const tempMiner = new NexusMiner({}, 1);
  tempMiner.logPane = logPane;
  tempMiner.uiScreen = screen;
  const { proxyList, proxyIPs } = await NexusMiner.loadProxies(tempMiner);
  let activeIndex = 0;
  let miners = [];

  function updateMiners() {
    miners = accounts.map((account, idx) => {
      const proxy = proxyList.length > 0 ? proxyList[Math.floor(Math.random() * proxyList.length)] : 'None';
      const proxyIp = proxy !== 'None' ? proxyIPs[proxy] || 'Unknown' : null;
      const miner = new NexusMiner(account, account.id, proxy, proxyIp);
      miner.uiScreen = screen;
      miner.accountPane = accountPane;
      miner.logPane = logPane;
      miner.addLog(chalk.cyan(`Account ${account.id} loaded with proxy: ${proxy}`));
      return miner;
    });

    if (miners.length > 0) {
      miners[activeIndex].isDisplayed = true;
      miners[activeIndex].addLog(chalk.green('Miner initialized successfully'));
      miners[activeIndex].refreshDisplay();
      miners.forEach(miner => miner.start());
    } else {
      logPane.setContent('No valid accounts found in account.json.\nPress "q" or Ctrl+C to exit.');
      accountPane.setContent('');
      screen.render();
    }
  }

  try {
    updateMiners();
  } catch (error) {
    logPane.setContent(`Failed to reload miners: ${error.message}\nPress "q" or Ctrl+C to exit.`);
    screen.render();
    return;
  }

  if (!miners.length) {
    screen.key(['escape', 'q', 'C-c'], () => {
      screen.destroy();
      process.exit(0);
    });
    screen.render();
    return;
  }

  infoPane.setContent(`Current Account: ${(miners.length > 0 ? activeIndex + 1 : 0)}/${miners.length} | Use Left/Right arrow keys to switch accounts. Press "m" for menu.`);

  screen.key(['escape', 'q', 'C-c'], async () => {
    for (const miner of miners) {
      if (miner.miningInterval) {
        clearInterval(miner.miningInterval);
      }
      if (miner.toggleCheckInterval) {
        clearInterval(miner.toggleCheckInterval);
      }
      miner.addLog(chalk.yellow('Miner stopped'));
      await miner.closeBrowser();
    }
    screen.destroy();
    process.exit(0);
  });

  screen.key(['right'], () => {
    if (miners.length === 0) return;
    miners[activeIndex].isDisplayed = false;
    activeIndex = (activeIndex + 1) % miners.length;
    miners[activeIndex].isDisplayed = true;
    miners[activeIndex].refreshDisplay();
    infoPane.setContent(`Current Account: ${activeIndex + 1}/${miners.length} | Use Left/Right arrow keys to switch accounts. Press "m" for menu.`);
    screen.render();
  });

  screen.key(['left'], () => {
    if (miners.length === 0) return;
    miners[activeIndex].isDisplayed = false;
    activeIndex = (activeIndex - 1 + miners.length) % miners.length;
    miners[activeIndex].isDisplayed = true;
    miners[activeIndex].refreshDisplay();
    infoPane.setContent(`Current Account: ${activeIndex + 1}/${miners.length} | Use Left/Right arrow keys to switch accounts. Press "m" for menu.`);
    screen.render();
  });

  screen.key(['m', 'M'], async () => {
    const miner = miners[activeIndex];
    const options = ['Start Mining', 'Refresh Account', 'Clear Logs', 'Exit', 'Back'];
    if (miner.isMining) {
      options.splice(1, 0, 'Stop Mining');
    }
    const menu = blessed.list({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: options.length + 4,
      border: { type: 'line' },
      label: ' Menu ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'cyan' },
        selected: { bg: 'blue', fg: 'white' },
        item: { fg: 'white' }
      },
      keys: true,
      mouse: true,
      items: options,
    });

    menu.on('select', async (item, index) => {
      const choice = options[index];
      menu.destroy();
      screen.render();
      if (choice === 'Start Mining') {
        await miner.startMining();
      } else if (choice === 'Stop Mining') {
        await miner.stopMining();
      } else if (choice === 'Refresh Account') {
        await miner.refreshAccount();
      } else if (choice === 'Clear Logs') {
        miner.clearLogs();
      } else if (choice === 'Exit') {
        for (const m of miners) {
          if (m.miningInterval) clearInterval(m.miningInterval);
          if (m.toggleCheckInterval) clearInterval(m.toggleCheckInterval);
          await m.closeBrowser();
        }
        screen.destroy();
        process.exit(0);
      } else if (choice === 'Back') {
      }
    });

    menu.on('cancel', () => {
      menu.destroy();
      screen.render();
    });

    menu.key(['escape', 'q'], () => {
      menu.destroy();
      screen.render();
    });

    menu.focus();
    screen.render();
  });

  screen.on('resize', () => {
    renderBanner();
    headerPane.width = '100%';
    channelPane2.top = headerPane.height;
    accountPane.top = dashTop;
    logPane.top = dashTop;
    screen.render();
  });

  screen.render();
}

main().catch(error => {
  const screen = blessed.screen({ smartCSR: true, title: 'NEXUS WEB AUTO MINING' });
  const logPane = blessed.box({
    top: 'center',
    left: 'center',
    width: '80%',
    height: '100%',
    border: { type: 'line' },
    label: ' System Logs ',
    content: `Failed to start: ${error.message}\nPlease fix the issue and retry.\nPress "q" or Ctrl+C to exit`,
    style: { border: { fg: 'red' }, fg: 'blue', bg: 'default' },
  });
  screen.append(logPane);
  screen.key(['escape', 'q', 'C-c'], () => {
    screen.destroy();
    process.exit(0);
  });
  screen.render();
});