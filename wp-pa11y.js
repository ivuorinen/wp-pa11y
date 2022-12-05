#!/usr/bin/env node

import * as pa11yReporterCli from 'pa11y/lib/reporters/cli.js';
import fetch from "node-fetch";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as pa11yReporterHtml from "pa11y-reporter-html";
import { Agent } from "https";
import pa11y from "pa11y";
import path from "path";
import * as puppeteer from "puppeteer";
import { Parser } from "xml2js";
import { Option, program } from "commander";
import { cwd } from 'process';
import { cosmiconfigSync, defaultLoaders } from "cosmiconfig";
import * as url from 'url'

// Hack to set __dirname in ES module scope
const __dirname = url.fileURLToPath( new URL( '.', import.meta.url ) );

// Configuration.
const outputDir = path.resolve( cwd(), "output" );
const packageJson = JSON.parse( readFileSync( path.resolve( __dirname, 'package.json' ), 'utf-8' ) );
const name = packageJson.name || "wp-pa11y";
const version = packageJson.version || "0.0.0";

program
    .name( name )
    .version( version, "-v, --version", "output the current version" )
    .addOption(
        new Option( "-o, --output <type>", "output type" )
            .choices( [ "console", "html" ] )
            .default( "console" )
            .env( "WP_PA11Y_OUTPUT" )
    )
    .option( "-d, --destination <path>", "Output destination", outputDir )
    .option( "-s, --sitemaps <sitemap urls...>", "specify one or more sitemaps for manual runs" );


const cosmicConfig = cosmiconfigSync( name, {
    searchPlaces: [
        "sitemaps.txt",
        "package.json"
    ],
    loaders: {
        ".txt": defaultLoaders[ "noExt" ]
    }
} );
const searchedFor = cosmicConfig.search();

if ( searchedFor === null || searchedFor.isEmpty ) {
    console.error( "Could not find configuration. Please check docs and try again." );
    program.help();
}

const config = cosmicConfig.load( searchedFor.filepath );

program.parse();

const opts = program.opts();

const reportType = program.getOptionValue( 'output' );
let sitemaps = config.config;

if ( sitemaps instanceof String || ! ( sitemaps instanceof Array ) ) {
    sitemaps = sitemaps.split( " " );
}

if ( opts.sitemap && opts.sitemaps.length ) {
    sitemaps = sitemaps.concat( opts.sitemaps || [] )
        .filter( ( a ) => a.length );
}

sitemaps = sitemaps
    .map( ( a ) => a.toString().trim() )
    .filter( ( a ) => a.length );

// Make sure only unique values are present.
sitemaps = Array.from( new Set( sitemaps ) );

if ( sitemaps.length === 0 ) {
    console.error( "No sitemaps to process. Exiting." );
    process.exit( 0 );
}

console.log( "Running Pa11y for: ", sitemaps.join( ", " ) );

sitemaps.forEach( async ( url ) => {
    const folderName = ( new URL( url ) ).hostname
        .replace( "www.", "" )
        .replace( ".", "" );

    const dir = path.resolve( outputDir, folderName );

    if ( ! existsSync( dir ) && reportType === "html" ) {
        mkdirSync( dir, { recursive: true } );
    }

    const urlList = await getUrls( url );
    const urlObj = {
        folderName,
        urlList
    };

    if ( urlObj.urlList.length > 0 ) {
        runPa11y( urlObj );
    }
} );

/**
 * Get urls from sitemap
 *
 * @param {string} url
 * @returns {Promise}
 */
async function getUrls( url ) {
    // Bypass self-signed cert
    const httpsAgent = new Agent( {
        rejectUnauthorized: false
    } );

    const response = await fetch( url, { method: "GET", agent: httpsAgent } );
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
 * @param {object} urlObj Object containing folder name and url list.
 * @return {void}
 */
async function runPa11y( urlObj ) {
    let browser;
    let pages = [];

    async function writeResultsHtml( results, i, urlList, folderName ) {
        const htmlResults = await pa11yReporterHtml.results( results[ i ] );
        const fileName = getFileName( urlList[ i ] );
        const htmlOutput = path.resolve( outputDir, folderName, fileName );

        writeFileSync( htmlOutput, htmlResults );
    }

    try {
        const options = {
            log: {
                debug: console.log,
                error: console.error,
                info: console.log
            },
            runners: [ "axe", "htmlcs" ]
        };

        browser = await puppeteer.launch();
        const results = [];
        const { folderName, urlList } = urlObj;

        for ( let i = 0; i < urlList.length; i++ ) {
            pages.push( await browser.newPage() );

            results[ i ] = await pa11y( urlList[ i ], {
                browser,
                page: pages[ i ],
                log: options.log,
                runners: options.runners
            } );

            if ( reportType === "html" ) {
                await writeResultsHtml( results, i, urlList, folderName );
            }
            else {
                console.log( pa11yReporterCli.results( results[ i ] ) );
            }
        }

        for ( const page of pages ) {
            await page.close();
        }

        await browser.close();
    } catch ( error ) {
        console.error( error.message );
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
        .replace( /[^\w\s-]/g, "" )
        .replace( /[\s_-]+/g, "-" )
        .replace( /^-+|-+$/g, "" )
        .replace( "httpswww", "" );

    const dt = new Date();

    return `${ dt.getFullYear() }-${
        dt.getMonth() + 1
    }-${ dt.getDate() }-${ fileName }.html`;
}
