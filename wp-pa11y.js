#!/usr/bin/env node
/**
 * @typedef { import('@types/pa11y').Options } Pa11yOptions
 */

import fetch from 'node-fetch';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { Agent } from 'https';
import pa11y from 'pa11y';
import path from 'path';
import { Parser } from 'xml2js';
import { Option, program } from 'commander';
import { cwd } from 'process';
import { cosmiconfigSync } from 'cosmiconfig';
import * as url from 'url'
import cliProgress from 'cli-progress'
import puppeteer from 'puppeteer';
import chalk from 'chalk';

import pa11yReporterCli from 'pa11y/lib/reporters/cli.js'
import pa11yReporterJson from 'pa11y/lib/reporters/json.js'
import pa11yReporterHtml from 'pa11y/lib/reporters/html.js'

// Hack to set __dirname in ES module scope
const __dirname = url.fileURLToPath( new URL( '.', import.meta.url ) );

// For logging
const log = console.log;
const ok = ( str ) => log( chalk.green( '(*) %s' ), str );
const error = ( str ) => log( chalk.bold.red( '(!) %s' ), str );

// Configuration.
const outputDir = path.resolve( cwd(), 'output' );
const packageJson = JSON.parse( readFileSync( path.resolve( __dirname, 'package.json' ), 'utf-8' ) );
const name = packageJson.name || 'wp-pa11y';
const version = packageJson.version || '0.0.0';

/**
 * This is the basic structure for our configuration.
 * @see https://www.npmjs.com/package/pa11y#configuration
 * @augments {Pa11yOptions}
 * @type {object} defaultConfig
 */
let defaultConfig = {
    sitemaps: [],
    standard: 'WCAG2AA',
    actions: [],
    reporter: 'html',
    includeNotices: false,
    method: 'GET',
    runners: [
        'axe',
        'htmlcs'
    ],
    viewport: {
        width: 1280,
        height: 1024
    }
};

program
    .name( name )
    .version( version, '-v, --version', 'Output the current version' )
    .addOption(
        new Option( '-r, --reporter <type>', 'Reporter type' )
            .choices( [ 'console', 'html' ] )
            .default( defaultConfig.reporter )
            .env( 'WP_PA11Y_REPORTER' )
    )
    .option( '-d, --destination [path]', 'Output destination', outputDir )
    .option( '-s, --sitemaps [sitemap urls...]', 'Specify one or more sitemaps for manual runs' );

program.parse();
const opts = program.opts();

// Initialize configuration loader.
// This will load configuration from "wp-pa11y" key in package.json
// and the usual rc-files like .wp-pa11yrc, .wp-pa11yrc.{json|yaml|yml|js}
const cosmicConfig = cosmiconfigSync( name );
const searchedFor = cosmicConfig.search();

const sitemapAmount = typeof opts.sitemaps !== 'undefined' && opts.sitemaps.length || 0;

if ( sitemapAmount < 1 && searchedFor === null ) {
    error( 'Could not find configuration. Please check docs and try again.' );
    program.help();
}

let loadedConfig = {
    sitemaps: opts.sitemaps || []
}

if ( searchedFor && typeof searchedFor.filepath !== 'undefined' ) {
    const cosmic = cosmicConfig.load( searchedFor.filepath );

    loadedConfig = {
        ...loadedConfig,
        ...cosmic.config || {}
    };
}
/**
 * The real configuration combined from our defaults
 * and what has been provided.
 *
 * @augments {Pa11yOptions}
 * @type {Object}
 */
let config = {
    ...defaultConfig,
    ...loadedConfig
}

// Trim and filter empty items.
config.sitemaps = config.sitemaps
    .map( ( a ) => a.toString().trim() )
    .filter( ( a ) => a.length );

// Make sure only unique values are present.
config.sitemaps = Array.from( new Set( config.sitemaps ) );


if ( config.sitemaps.length === 0 ) {
    console.error( 'No sitemaps to process. Exiting.' );
    process.exit( 0 );
}

console.log( 'Running Pa11y for: ', config.sitemaps.join( ', ' ) );

config.sitemaps.forEach( async ( url ) => {
    ok(`Starting to process sitemap: ${ url }`);
    const folderName = ( new URL( url ) ).hostname
        .replace( 'www.', '' )
        .replace( '.', '' );

    const dir = path.resolve( outputDir, folderName );

    if ( ! existsSync( dir ) && config.reporter === 'html' ) {
        mkdirSync( dir, { recursive: true } );
    }

    const urlList = await getUrls( url );
    const urlObj = {
        folderName,
        urlList
    };

    if ( urlObj.urlList.length > 0 ) {
        runPa11y( urlObj, config );
    }
} );

/**
 * Get urls from sitemap
 *
 * @param {string} url sitemap.xml address
 * @returns {Promise}
 */
async function getUrls( url ) {
    // Bypass self-signed cert
    const httpsAgent = new Agent( {
        rejectUnauthorized: false
    } );

    const response = await fetch( url, { method: 'GET', agent: httpsAgent } );
    const content = await response.text();
    const parser = new Parser();
    const data = await parser.parseStringPromise( content );

    return Promise.resolve(
        data.urlset.url.length
            ? data.urlset.url.map( ( link ) => link.loc[ 0 ] )
            : []
    );
}

/**
 * Run Pa11y for given urls
 *
 * @param {{folderName: string, urlList: array}} urlObj Object containing folder name and url list.
 * @param {object} pa11yConfig wp-pa11y Configuration object.
 * @return {void}
 */
async function runPa11y( urlObj, pa11yConfig = {} ) {
    let pages = [];

    /**
     * Take pa11y results and process it to a single HTML page.
     *
     * @param {Array} results Array of results.
     * @param {int} i Which result to write.
     * @param {Array} urlList
     * @param {string} folderName
     * @returns {Promise<void>}
     */
    async function writeResultsHtml( results, i, urlList, folderName ) {
        const htmlResults = await pa11yReporterHtml.results( results[ i ] );
        const fileName = getFileName( urlList[ i ] );
        const htmlOutput = path.resolve( outputDir, folderName, fileName );

        writeFileSync( htmlOutput, htmlResults );
    }

    ok(`Found ${ urlObj.urlList.length } pages, starting to process them...`);

    const bar = new cliProgress.SingleBar( {}, cliProgress.Presets.shades_grey );

    try {
        const browser = await puppeteer.launch();

        const results = [];
        const { folderName, urlList } = urlObj;

        bar.start( urlList.length, 0 );

        for ( let i = 0; i < urlList.length; i++ ) {
            bar.increment();

            pages.push( await browser.newPage() );

            results[ i ] = await pa11y( urlList[ i ], {
                page: pages[ i ],
                browser,
                ...pa11yConfig
            } );

            if ( pa11yConfig.reporter === 'html' ) {
                await writeResultsHtml( results, i, urlList, folderName );
            }
            else {
                pa11yReporterJson.results( results[ i ] );
            }
        }

        for ( const page of pages ) {
            await page.close();
        }

        bar.stop();

        await browser.close();
    } catch ( error ) {
        console.error( error.message );
        bar.stop();
    }
}

/**
 * Get file name
 *
 * @param {string} url
 * @return {string}
 */
function getFileName( url ) {
    let fileName = url
        .toLowerCase()
        .trim()
        .replace( /[^\w\s-]/g, '' )
        .replace( /[\s_-]+/g, '-' )
        .replace( /^-+|-+$/g, '' )
        .replace( 'httpswww', '' );

    const dt = new Date();

    return `${ dt.getFullYear() }-${
        dt.getMonth() + 1
    }-${ dt.getDate() }-${ fileName }.html`;
}
