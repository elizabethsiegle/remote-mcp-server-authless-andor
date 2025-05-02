import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import puppeteer, { Browser } from "@cloudflare/puppeteer";
import { env } from 'cloudflare:workers'

interface Env {
	AI: any;
	BROWSER: any;
	MCP: DurableObjectNamespace;
}

function getEnv<Env>() {
	return env as Env
}

const env2 = getEnv<Env>()
console.log(`env2: ${JSON.stringify(env2)}`)

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server: McpServer;

	private browser: Browser | null = null;
	private lastBrowserInit: number = 0;
	private readonly BROWSER_TIMEOUT = 5 * 60 * 1000; // 5 minutes
	private initPromise: Promise<void> | null = null;
	private isInitializing = false;

	constructor(state: any) {
		const server = new McpServer({
			name: "Andor Search",
			version: "1.0.0",
		});
		super(state, { server });
		this.server = server;
		this.initializeTools();
	}

	async init() {
		// If already initializing, wait for current init to complete -> Prevents multiple simultaneous initializations
		if (this.isInitializing) {
			console.log('Browser initialization in progress, waiting...');
			await this.initPromise;
			return;
		}

		// Check if we need to reinitialize the browser
		const now = Date.now();
		if (this.browser && (now - this.lastBrowserInit) < this.BROWSER_TIMEOUT) {
			console.log('Using existing browser instance');
			return;
		}

		this.isInitializing = true;
		this.initPromise = (async () => {
			try {
				console.log('Starting browser initialization...');
				
				// Close existing browser if it exists
				if (this.browser) {
					console.log('Closing existing browser instance');
					await this.browser.close();
					this.browser = null;
				}

				// Properly initialize the browser binding/handle browser binding errs
				const browserBinding = (env as any).BROWSER;
				if (!browserBinding) {
					throw new Error('BROWSER binding not found in environment');
				}

				// Create a new browser instance using the binding
				this.browser = await puppeteer.launch(browserBinding);
				this.lastBrowserInit = now;
				console.log('Browser launched successfully');
			} catch (error: unknown) {
				console.error('Browser initialization failed:', error instanceof Error ? error.message : 'Unknown error');
				if (error instanceof Error) {
					console.error('Error stack:', error.stack);
				}
				this.browser = null;
			} finally {
				this.isInitializing = false;
				this.initPromise = null;
			}
		})();

		await this.initPromise;
	}

	async cleanup() {
		if (this.browser) { // cleanup if browser exists
			try {
				console.log('Cleaning up browser instance');
				await this.browser.close();
				this.browser = null; // clear the browser instance
				this.lastBrowserInit = 0; // reset the last browser init time
			} catch (error) {
				console.error('Error during browser cleanup:', error);
			}
		}
	}

	private initializeTools() {
		// Andor episode summary tool
		this.server.tool(
			"get_andor_episode_summary",
			{
				episode: z.string().describe("The episode number or title to get a summary for"),
			},
			async ({ episode }: { episode: string }) => {
				try {
					// Ensure browser is initialized
					await this.init();

					if (!this.browser) {
						console.error('Browser state:', {
							browserExists: !!this.browser,
							envHasBrowser: !!(env as any).BROWSER
						});
						return {
							content: [{
								type: "text",
								text: "Error: Browser functionality is not available. This could be due to:\n1. Missing BROWSER binding in your Cloudflare Workers configuration\n2. Insufficient permissions to use the browser binding\n3. Browser initialization failed\n\nPlease check your wrangler.jsonc configuration and ensure you have the necessary permissions.",
							}],
						};
					}

					const baseUrl = 'https://starwars.fandom.com/wiki/Andor_Season_2#episodes';
					console.log('Creating new page for URL:', baseUrl);
					const page = await this.browser.newPage();
					
					// Set realistic browser headers
					await page.setExtraHTTPHeaders({
						'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
						'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
						'Accept-Language': 'en-US,en;q=0.9',
						'Accept-Encoding': 'gzip, deflate, br',
						'Connection': 'keep-alive',
						'Upgrade-Insecure-Requests': '1',
						'Sec-Fetch-Dest': 'document',
						'Sec-Fetch-Mode': 'navigate',
						'Sec-Fetch-Site': 'none',
						'Sec-Fetch-User': '?1',
						'Cache-Control': 'max-age=0'
					});

					// Set viewport
					await page.setViewport({
						width: 1280,
						height: 800,
						deviceScaleFactor: 1
					});

					// Enable JavaScript and set other browser features
					await page.setJavaScriptEnabled(true);
					await page.setBypassCSP(true);

					// Handle page errors
					page.on('error', err => {
						console.error('Page error:', err);
					});

					// Navigate to the base page
					const response = await page.goto(baseUrl, {
						waitUntil: 'networkidle0',
						timeout: 30000
					});

					if (!response || response.status() !== 200) {
						throw new Error(`Failed to load page: ${response?.status()}`);
					}

					// Find the episode link
					const episodeLink = await page.evaluate((episode) => {
						console.log('Searching for episode:', episode);
						
						// Find the episodes table
						const episodesTable = document.querySelector('table.wikitable');
						if (!episodesTable) {
							console.log('Could not find episodes table');
							return null;
						}
						
						console.log('Found episodes table');
						
						// Find all rows in the table
						const rows = Array.from(episodesTable.querySelectorAll('tr'));
						console.log('Found rows:', rows.length);
						
						// Find the row with the matching episode number
						const targetRow = rows.find(row => {
							const firstCell = row.querySelector('td:first-child');
							if (!firstCell) return false;
							
							const cellText = firstCell.textContent?.trim();
							console.log('Checking row with number:', cellText);
							return cellText === episode;
						});
						
						if (!targetRow) {
							console.log('Could not find row for episode:', episode);
							return null;
						}
						
						// Find the episode link in the third cell (title cell)
						const titleCell = targetRow.querySelector('td:nth-child(3)');
						if (!titleCell) {
							console.log('Could not find title cell');
							return null;
						}
						
						const episodeLink = titleCell.querySelector('a');
						if (!episodeLink) {
							console.log('Could not find episode link');
							return null;
						}
						
						const href = episodeLink.getAttribute('href');
						console.log('Found episode link:', href);
						return href;
					}, episode);

					if (!episodeLink) {
						console.log('No episode link found');
						return {
							content: [{
								type: "text",
								text: `Could not find episode: ${episode}`
							}],
						};
					}

					console.log('Found episode link:', episodeLink);

					// Navigate to the episode page
					const episodeUrl = new URL(episodeLink, baseUrl).toString();
					console.log('Navigating to episode page:', episodeUrl);
					
					// Add retry logic for page loading
					let episodeResponse = null;
					let retryCount = 0;
					const maxRetries = 3;
					
					while (retryCount < maxRetries) {
						try {
							episodeResponse = await page.goto(episodeUrl, {
								waitUntil: 'networkidle0',
								timeout: 30000
							});
							
							// 304 is actually okay - it means the page hasn't changed
							if (episodeResponse && (episodeResponse.status() === 200 || episodeResponse.status() === 304)) {
								break;
							}
							
							console.log(`Attempt ${retryCount + 1} failed with status: ${episodeResponse?.status()}`);
							retryCount++;
							await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
						} catch (error) {
							console.log(`Attempt ${retryCount + 1} failed with error:`, error);
							retryCount++;
							await new Promise(resolve => setTimeout(resolve, 1000));
						}
					}
					
					if (!episodeResponse || (episodeResponse.status() !== 200 && episodeResponse.status() !== 304)) {
						throw new Error(`Failed to load episode page after ${maxRetries} attempts. Last status: ${episodeResponse?.status()}`);
					}
					
					console.log('Successfully loaded episode page');

					// Extract episode content
					const episodeContent = await page.evaluate(() => {
						console.log('Starting plot summary extraction...');
						
						// First try to find the plot summary section directly
						const plotSummary = Array.from(document.querySelectorAll('h2')).find(el => {
							const text = el.textContent?.toLowerCase();
							console.log('Checking h2:', text);
							return text?.includes('plot summary');
						});
						
						if (!plotSummary) {
							console.log('Could not find plot summary section directly');
							return null;
						}
						
						console.log('Found plot summary section:', plotSummary.textContent);
						
						// Get all subsections between plot summary and credits
						const sections = [];
						let currentElement: Element | null = plotSummary.nextElementSibling;
						
						// Continue until we hit the Credits section
						while (currentElement && !currentElement.textContent?.toLowerCase().includes('credits')) {
							console.log('Current element:', currentElement.tagName, currentElement.textContent?.substring(0, 50));
							
							if (currentElement.matches('h3')) {
								const sectionTitle = currentElement.textContent?.trim() || '';
								console.log('Found section:', sectionTitle);
								
								let content = '';
								let contentElement: Element | null = currentElement.nextElementSibling;
								
								// Collect content until next h3 or h2
								while (contentElement && !contentElement.matches('h2, h3')) {
									if (contentElement.matches('p')) {
										// Clean up the text content
										const text = contentElement.textContent?.trim();
										if (text && text.length > 0) {
											content += text + '\n';
											console.log('Added paragraph:', text.substring(0, 50) + '...');
										}
									}
									contentElement = contentElement.nextElementSibling;
								}
								
								if (content.trim()) {
									sections.push({
										title: sectionTitle,
										content: content.trim()
									});
									console.log('Added section with content length:', content.length);
								}
							}
							currentElement = currentElement.nextElementSibling;
						}
						
						console.log('Found total sections:', sections.length);
						
						// Format the sections for output
						if (sections.length === 0) {
							console.log('No sections found');
							return null;
						}
						
						const formattedContent = sections.map(section => 
							`${section.title}\n${section.content}`
						).join('\n\n');
						
						console.log('Formatted content length:', formattedContent.length);
						return formattedContent;
					});

					await page.close();

					if (!episodeContent) {
						console.log('No episode content extracted');
						return {
							content: [{
								type: "text",
								text: `Could not extract plot summary for episode: ${episode}`
							}],
						};
					}

					console.log('Successfully extracted episode content');

					// Use Cloudflare AI to generate a summary
					const messages = [
						{ 
							role: "system", 
							content: "You are a Star Wars expert. Create a summary of the Andor episode based on the provided plot points. Separate the summary into paragraphs with each paragraph with a title being a section from the scraped website. Include key plot points, character development, and important events. Keep it engaging and informative. Format the summary with clear sections and bullet points where appropriate." 
						},
						{
							role: "user",
							content: `Episode: ${episode}\nPlot Summary:\n${episodeContent}`
						}
					];

					const analysis = await (env as any).AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages });

					return {
						content: [{
							type: "text",
							text: analysis.response || "Unable to generate episode summary."
						}],
					};
				} catch (error) {
					console.error('Error getting Andor episode summary:', error);
					return {
						content: [{
							type: "text",
							text: `Error getting Andor episode summary: ${error instanceof Error ? error.message : 'Unknown error occurred'}`
						}],
					};
				}
			}
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			// @ts-ignore
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			// @ts-ignore
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};