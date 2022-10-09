const express = require("express");
const router = express.Router();
const firedb = require('../firebase/fire.js')
const db = require("../connection");
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())
require('dotenv').config(); // setting up
const TfIdf = require('tf-idf-search');



const {
    cekJWT
} = require("../middleware");

const {
    KMA
} = require("./KMA");


// get user log id status
router.get('/user_logs/:user_log_id/status', cekJWT, async (req, res) => {
    let hasil = ''
    const resu = await firedb.collection('user_logs').doc(`${req.params.user_log_id}`).get()
    
    resu.forEach((doc) => {
        hasil = doc.data().status
    });


    return res.status(200).json({
        'message': 'User Logs status',
        'status': hasil,
        'status': 'Success'
    });
});

// get user_logs id (key) untuk dapetin search result dari firebase yang user_log_idnya sama
router.post('/search_result_key', cekJWT, async (req, res) => {
    if(req.body.keyword && req.body.yearStart && req.body.yearEnd){
        let data = await db.query(`SELECT * FROM search_factors WHERE user_id=${req.user.id} AND deleted_at IS NULL`)

        let query = await firedb.collection('user_logs')
        query = query.where('keyword', '==', req.body.keyword)
        query = query.where('year_start', '==', req.body.yearStart)
        query = query.where('year_end', '==', req.body.yearEnd)
        query = query.where('crawler_opt', '==', req.body.crawlerOpt)
        const resu = await query.get()
        if (resu.empty) {
            // belum pernah dicrawl dan ranking
            return res.status(200).json({
                'message': 'Keyword is new',
                'key': '-1',
                'status': 'Success'
            });
        }

        // cari search factor yang sama persis
        let key = '-1' // -1 : tidak ada search factor yang sama persis
        resu.forEach(doc => {
            const sf = doc.data().factors

            // length search factor yang dimiliki user harus sama dengan search factor dari search result yang perna ada
            if(data.length == sf.length){
                let ctr = 0
                for (let i = 0; i < data.length; i++){
                    for (let j = 0; j < sf.length; j++){
                        if(data[i].factor === sf[j].factor && data[i].sub_factor === sf[j].sub_factor) {
                            ctr++
                        }
                    }
                }

                if (ctr == data.length) {
                    // ctr == data.length, keyword dan search factor ada yang sama persis berarti result journal sama
                    if (parseInt(doc.data().status) == 1 || parseInt(doc.data().status) == 2) {
                        // status 1 artinya sudah diupdate
                        // status 2 artinya masih belum diupdate cron job
                        // returnkan id (key) untuk FE req dapetin search result
                        key = doc.id
                    } else if (parseInt(doc.data().status) == 3) {
                        // lagi diupdate cron job resultnya
                        key = '-3'
                    }
                }
            }
        });

        return res.status(200).json({
            'key': key,
            'status': 'Success'
        });
    }else{
        return res.status(401).json({
            'message': 'Inputan Belum lengkap!',
            'data':{
            },
            'status': 'Error'
        });
    }
});

// API ini dipanggil jika Error  --> masih proses crawl and rank
router.post('/crawlAndRank', cekJWT, async (req, res) => {
    if (req.body.keyword && req.body.ogKeyword && req.body.yearStart && req.body.yearEnd){
        // get user search factor
        const sf = await db.query(`SELECT * FROM search_factors WHERE user_id=${req.user.id} AND deleted_at IS NULL`)
        // crawl and ranking
        const results = await crawlAndRank(req.body.keyword, req.body.ogKeyword, sf, true, req.body.yearStart, req.body.yearEnd, parseInt(req.body.crawlerOpt))

        // add new user log
        const userLogId = await addNewUserLog(req)

        // insert journal result dan bindkan dengan userLogId
        await addJournalsResult(userLogId, results)

        // jika tidak timeout maka akan dikembalikan keynya (userLogId) langsung
        return res.status(200).json({
            'key': userLogId,
            'status': 'Success'
        });
    } else {
        return res.status(401).json({
            'message': 'Inputan Belum lengkap!',
            'data':{
            },
            'status': 'Error'
        });
    }
});

// focused crawler and ranking
// crawlerOpt : 0 : scholar, 1: scd, 2:ieee, 3:acd
async function crawlAndRank (keyword, ogKeyword, searchFactors = [], headless, yearStart, yearEnd, crawlerOpt = 1) {
    let results = []
    let simpleKeyword = '-' // untuk journal evaluation
    if (ogKeyword === '-') {
        // search biasa
        simpleKeyword = keyword
        if (simpleKeyword.includes('&')) {
            results.push({
                'g_id': 1,
                'title': 'application error'
            })
            return results
        }
    } else {
        // advanced search
        simpleKeyword = ogKeyword
    }

    // Crawl 
    try{
        // setting up puppeteer
        const browser = await puppeteer.launch({
            'args' : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized',
            ],
            defaultViewport: null,
            headless: headless
        })
        const page = await browser.newPage()

        // crawl bedasarkan crawl opt
        if (crawlerOpt === 0) {
            // scholar crawl
            MAX_CRAWL_DATA = 30
            let crawlInfo = {
                search_res_links: [],
                pageNum : 1,
                attempt : 1,
                yearStart: '',
                yearEnd: ''
            }
    
            if(yearStart !== '-') {
                crawlInfo.yearStart = yearStart
            }
            if(yearEnd !== '-') {
                crawlInfo.yearEnd = yearEnd
            }
    
            results = await googleScholarCrawl(browser, page, keyword, crawlInfo)
        } else if (crawlerOpt === 1) {
            // crawler SCD
            MAX_CRAWL_DATA = 40
            let date = ''
            if(yearStart !== '-' && yearEnd !== '-') {
                date = yearStart + '-' + yearEnd
            } else if (yearStart !== '-') {
                date = yearStart + '-2023'
            } else if (yearEnd !== '-') {
                date = '1990-' + yearEnd 
            }
    
            let crawlInfo = {
                search_res_links: [],
                pageNum : 1,
                attempt : 1,
                date: date,
                simpleKeyword: simpleKeyword
            }
    
            results = await scienceDirectCrawl(browser, page, keyword, crawlInfo)  
        } else if (crawlerOpt === 2) {
            // IEEE Crawler
            MAX_CRAWL_DATA = 25
            
            date = ''
            if(yearStart !== '-' && yearEnd !== '-') {
                date = `&ranges=${yearStart}_${yearEnd}_Year`
            } else if (yearStart !== '-') {
                date = `&ranges=${yearStart}_2023_Year`
            } else if (yearEnd !== '-') {
                date = `&ranges=1884_${yearEnd}_Year`
            }

            crawlInfo = {
                search_res_links: [],
                pageNum : 1,
                attempt : 1,
                date: date,
                simpleKeyword: simpleKeyword
            }

            results = await ieeeCrawl(browser, page, keyword, crawlInfo)
        } else if (crawlerOpt === 3) {
            // ACD Crawl
            MAX_CRAWL_DATA = 30

            if (ogKeyword === '-') {
                // search biasa
                keyword = 'q=' + keyword
            } else {
                // advanced search
                keyword = 'cqb=' + keyword
            }

            date = ''
            if(yearStart !== '-' && yearEnd !== '-') {
                date = `&rg_ArticleDate=01/01/${yearStart}%20TO%2012/31/${yearEnd}&dateFilterType=range&noDateTypes=true&rg_SearchResultsPublicationDate=01/01/${yearStart}%20TO%2012/31/${yearEnd}&rg_VersionDate=01/01/${yearStart}%20TO%2012/31/${yearEnd}`
            } else if (yearStart !== '-') { 
                date = `&rg_ArticleDate=01/01/${yearStart}%20TO%2012/31/2999&dateFilterType=range&noDateTypes=true&rg_SearchResultsPublicationDate=01/01/${yearStart}%20TO%2012/31/2999&rg_VersionDate=01/01/${yearStart}%20TO%2012/31/2999`
            } else if (yearEnd !== '-') {
                date = `&rg_ArticleDate=01/01/1980%20TO%2012/31/${yearEnd}&dateFilterType=range&noDateTypes=true&rg_SearchResultsPublicationDate=01/01/1980%20TO%2012/31/${yearEnd}&rg_VersionDate=01/01/1980%20TO%2012/31/${yearEnd}`
            }

            crawlInfo = {
                search_res_links: [],
                pageNum : 1,
                attempt : 1,
                date: date
            }

            results = await academicCrawl(browser, page, keyword, crawlInfo)
        }
    
        await browser.close()    
    }catch(e) {
        console.log(e)
        return res.status(501).json({
            'message': 'Error crawling',
            'data':{e
            },
            'status': 'Error'
        });
    }

    // focused crawl (cosinus similarity)
    // cosinusKeyword = simpleKeyword + search factor
    let cosinusKeyword = simpleKeyword
    let sfKeyword = ''
    if (searchFactors.length > 0) {
        sfKeyword = searchFactors[0].sub_factor // pure sf keyword
        for (let i = 0; i < searchFactors.length; i++) {
            if (i > 0) {
                sfKeyword += ' ' + searchFactors[i].sub_factor
            }
            cosinusKeyword += ' ' + searchFactors[i].sub_factor
        }
        sfKeyword.toLowerCase()
    }
    cosinusKeyword.toLowerCase()

    console.log('"' + cosinusKeyword + '"')
    console.log('"' + sfKeyword + '"')

    // journal valuation
    journalsEvaluation(results, cosinusKeyword, simpleKeyword, sfKeyword, crawlerOpt)

    // ranking with KMA
    results = KMA(results, results.length, Math.ceil(results.length / 2) + 5, 100, 5, crawlerOpt) 
    
    return results
}

// insert new user_log keyword setelah crawl dan ranking, dan returnkan key
async function addNewUserLog (req) {
    // * id yang di auto generate (user_log_id) akan disimpan di firebase tabel (journals_result)
    //   agar tau hasil crawl dan ranking berasal dari search keyword apa dan search factornya apa
    // * cron job crawl dan ranking akan dilakukan untuk user_logs yang status 2

    let data = await db.query(`SELECT * FROM search_factors WHERE user_id=${req.user.id} AND status=1 AND deleted_at IS NULL`)

    // insert new user log
    const factors = []

    for (let i = 0; i < data.length; i++){
        factors.push({
            id: data[i].id,
            factor: data[i].factor,
            sub_factor: data[i].sub_factor,
        })
    }

    // composite primary key (user_id, factors, keyword)
    data = await firedb.collection('user_logs').add({
        user_id: req.user.id,
        factors,
        keyword: req.body.keyword,
        og_keyword: req.body.ogKeyword, // dipake di cronjob
        year_start: req.body.yearStart,
        year_end: req.body.yearEnd,
        crawler_opt: parseInt(req.body.crawlerOpt), // apakah open journal aja atau tidak
        status: 2, // untuk cron job melakukan fully focused crawled and ranked
        created_at: new Date(),
        deleted_at: null
    });

    // returnkan key (id user log) yang baru diinsert
    return data.id
}

// insert new semua results dari hasil crawl dan ranking dan assign ke user_log_id
async function addJournalsResult (userLogId, results) {
    for (let i = 0; i < results.length; i++) {
        await firedb.collection('journals_result').add({
            rank: (i + 1),
            user_log_id: userLogId,
            g_id: results[i].journal.g_id,
            title: results[i].journal.title,
            content: results[i].journal.content,
            authors: results[i].journal.authors,
            publisher: results[i].journal.publisher,
            publish_year: results[i].journal.publish_year,
            free: results[i].journal.free,
            link: results[i].journal.link,
            pdf: results[i].journal.pdf,
            site: results[i].journal.site,
            cited_count: results[i].journal.cited_count,
            status: 1,
            created_at: new Date(),
            deleted_at: null
        });
    }
}

// dapetin semua journals result dengan user_log_id yang diminta
router.post('/searchResult', cekJWT, async (req, res) => {
    if(req.body.userLogId){
        let hasil = []
        let query = await firedb.collection('journals_result')
        query = query.where('user_log_id', '==', req.body.userLogId).orderBy('rank')
        const resu = await query.get()
        
        resu.forEach((doc) => {
            hasil.push(doc.data())
        });

        // cek pernah ga search result ini diarchive oleh user, Jika ya simpan data id journal
        for (let i = 0; i < hasil.length; i++) {
            hasil[i].journal_id = -1
            const data = await db.query(`SELECT id FROM journals WHERE g_id='${hasil[i].g_id}' AND user_id=${req.user.id} AND deleted_at IS NULL`)
            if (data.length > 0) {
                // pernah
                hasil[i].journal_id = data[0].id
            }
        }

        return res.status(200).json({
            'message': 'Query Success',
            hasil,
            'status': 'Success'
        });
    }else{
        return res.status(401).json({
            'message': 'Inputan Belum lengkap!',
            'data':{
            },
            'status': 'Error'
        });
    }
});



// scholar crawler SETUP
const MAX_RESET = 10
const MAX_PAGE = 10
let MAX_CRAWL_DATA = 25
const POSSIBLE_PDF_PLACEMENT = [
    'PDF',
    'pdf',
    'text',
    'article',
    'Download',
    'download',
    'Paper',
    'paper',
    'file'
]

async function recaptchaSolver(browser, page, keyword, crawlInfo) {
    try{
        if(crawlInfo.attempt == MAX_RESET) {
            return "Reach Maximum Callback Reset"
        }
        const recaptcha = await page.$eval(`body`, (result) => {
            return result.innerHTML
        })
        const $ = await cheerio.load(recaptcha + "")
        
        if ($('div').text().includes('Please try your request again later.')) {
            // reset
            await browser.close()
            browser = await puppeteer.launch({
                'args' : [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--start-maximized'
                ],
                defaultViewport: null,
                headless: true
            })
            page = await browser.newPage()
            crawlInfo.attempt++

            return googleScholarCrawl(browser, page, keyword, crawlInfo)
        }
    } catch (e) {
        console.log("error recaptcha : " + e)
    }
}

// target google scholar
async function googleScholarCrawl(browser, page, keyword, crawlInfo) {
    console.log("Page num : " + crawlInfo.pageNum)

    // buka halaman hasil pencarian google scholar
    await page.goto(`https://scholar.google.com/scholar?start=${((crawlInfo.pageNum * 10) - 10)}&q=${keyword}&hl=en&as_ylo=${crawlInfo.yearStart}&as_yhi=${crawlInfo.yearEnd}`, {
        waitUntil: 'networkidle2'
    })

    // recaptcha handler
    await recaptchaSolver(browser, page, keyword, crawlInfo)

    // dapatin html semua search result
    let searchResRaw = ''
    try{
        searchResRaw = await page.$$eval(".gs_r.gs_or.gs_scl", (results) => {
            const temp = []
            for (let i = 0; i < results.length; i++) {
                // dapatin html
                temp.push(results[i].innerHTML + "")
            }
            return temp
        })
    }catch (e) {
        console.log("error load html page : " + e)
        console.log("reseting page : " + crawlInfo.pageNum)
        // try to reset this page
        await browser.close()
        browser = await puppeteer.launch({
            'args' : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized'
            ],
            defaultViewport: null,
            headless: true
        })
        page = await browser.newPage()
        crawlInfo.attempt++

        return googleScholarCrawl(browser, page, keyword, crawlInfo)
    }
    if(searchResRaw.length === 0) {
        return crawlInfo.search_res_links
    }

    // dapetin informasi yang diperlukan
    for (let i = 0; i < searchResRaw.length; i++) {
        if (crawlInfo.search_res_links.length >= MAX_CRAWL_DATA) {
            return crawlInfo.search_res_links
        }
        const $ = await cheerio.load(searchResRaw[i] + "")

        // harus ada link website
        if ($(".gs_ri > .gs_rt > a").attr("href")) {
            // get info
            let obj = {
                abstract: 'no-abs',
                keywords: 'no-key',
                content: $(`.gs_ri > .gs_rs`).text(),
                cited_count: $(`.gs_ri > .gs_fl > a:contains('Cited by')`).text(),
                authors: '-',
                publisher: '-',
                publish_year: '-',
                site: '-',
                free: true,
                pdf: '-',
                link: $(".gs_ri > .gs_rt > a").attr("href")
            }
            const res = $(`.gs_ri > .gs_a`).text()
            
            obj.authors = res.substring(0, findDash(res, 0) - 1)
            if (res.indexOf(',', findDash(res, 0) + 1) > 0) {
                obj.publisher = res.substring(findDash(res, 0) + 2,  res.indexOf(',', findDash(res, 0) + 1))
                obj.publish_year = res.substring(res.indexOf(',', findDash(res, 0) + 1) + 2,  res.indexOf('-', findDash(res, 0) + 1) - 1)
            } else {
                if(isNaN(parseInt(res.substring(findDash(res, 0) + 1,  res.indexOf('-', findDash(res, 0) + 1) - 1)))) {
                    obj.publisher = res.substring(findDash(res, 0) + 1,  res.indexOf('-', findDash(res, 0) + 1) - 1)
                } else {
                    obj.publish_year = res.substring(findDash(res, 0) + 1,  res.indexOf('-', findDash(res, 0) + 1) - 1)
                }
            }
            obj.site = res.substring(res.indexOf('-', findDash(res, 0) + 1) + 2)

            if(obj.cited_count == '') {
                obj.cited_count = "Cited By 0"
            }

            // get abstract
            if(!$(".gs_ri > .gs_rt > a").attr("href").includes('.pdf')) {
                try{
                    await page.goto($(".gs_ri > .gs_rt > a").attr("href"), {
                        // timeout: 3000,
                        waitUntil: 'domcontentloaded'
                    })

                    const pageURL = page.url()
                    console.log("site url : " + pageURL.substring(0, pageURL.indexOf('/', 10)))

                    // get abstract possible locations and keywords possible location
                    let query = await firedb.collection('abstract_possible_locations')
                    query = query.where('site_url', '==', pageURL.substring(0, pageURL.indexOf('/', 10)))
                    const resu = await query.get()

                    if (!resu.empty) {
                        let selector = '-'
                        let keywordSelector = '-'
                        resu.forEach((doc) => {
                            selector = doc.data().selector
                            keywordSelector = doc.data().keyword_selector
                        });

                        // dapetin abstract
                        if (selector != '-' && selector != 'no-abs') {
                            try {
                                obj.abstract = await page.$eval(`${selector}`, (result) => {
                                    return result.textContent.toLowerCase()
                                })
                            } catch (e) {
                                console.log('error evaluate abstract: ' + e)
                            }
                        }

                        // dapetin keywords
                        if (keywordSelector && keywordSelector != '-' && keywordSelector != 'no-key') {
                            try {
                                obj.keywords = await page.$eval(`${keywordSelector}`, (result) => {
                                    return result.innerText
                                })
                            } catch (e) {
                                console.log('error evaluate keyword : ' + e)
                            }
                        }

                        // refine abstract
                        obj.abstract = obj.abstract.replaceAll('\n', ' ')
                        obj.abstract = obj.abstract.replaceAll('\t', ' ')
                        obj.abstract = obj.abstract.replaceAll(':', '')
                        obj.abstract = obj.abstract.replaceAll('.', '')
                        obj.abstract = obj.abstract.replaceAll(',', ' ')
                        obj.abstract = obj.abstract.replaceAll('abstract', '')
                        obj.abstract = obj.abstract.replaceAll('(', '')
                        obj.abstract = obj.abstract.replaceAll(')', '')
                        obj.abstract = obj.abstract.replace(/\s\s+/g, ' ')

                        if (keywordSelector != 'no-key') {
                            // refine keywords
                            obj.keywords = obj.keywords.replaceAll('\n', ' ')
                            obj.keywords = obj.keywords.replaceAll(',', '')
                            obj.keywords = obj.keywords.replaceAll(';', '')
                            obj.keywords = obj.keywords.replaceAll('Keywords:', '')
                            obj.keywords = obj.keywords.replaceAll('Keywords', '')
                            let keywords = obj.keywords
                            obj.keywords = keywords[0]
                            for (let i = 1; i < keywords.length; i++) {
                                if (keywords[i].toUpperCase() === keywords[i] && keywords[i - 1] !== ' ' && keywords[i] !== '-' && keywords[i] !== ' ') {
                                    obj.keywords += ' '
                                } 
                                obj.keywords += keywords[i]
                            }
                        }
                        obj.keywords.toLowerCase()
                    } else {
                        // site url baru, insert
                        await firedb.collection('abstract_possible_locations').add({
                            full_url: pageURL,
                            site_url: pageURL.substring(0, pageURL.indexOf('/', 10)),
                            selector: '-',
                            keyword_selector: '-',
                        });
                    }

                    if ($(".gs_ggs.gs_fl").text() != '') {
                        // jika ada direct link ( tidak berbayar )
                        if ($(".gs_ggs.gs_fl > .gs_ggsd > .gs_or_ggsm > a > span").text().toLowerCase().includes("html")) {
                            // link website, bukan .pdf harus masuk untuk dapetin .pdf
                            const body = await page.$eval(`body`, (result) => {
                                return result.innerHTML
                            })
                            const jq = await cheerio.load(body + "")

                            // cari penempatan link pdf di semua kemungkinan
                            for (let j = 0; j < POSSIBLE_PDF_PLACEMENT.length; j++) {
                                obj.pdf = jq(`a:contains('${POSSIBLE_PDF_PLACEMENT[j]}')`).attr("href")
                                if(obj.pdf) {
                                    if(!obj.pdf.includes("https")) {
                                        // jika pdf tidak mengandung base url
                                        obj.pdf = pageURL.substring(0, pageURL.indexOf('/', 10)) + obj.pdf + ''
                                    }
                                    break
                                }
                            }
                        } else {
                            obj.pdf = $(".gs_ggs.gs_fl > .gs_ggsd > .gs_or_ggsm > a").attr("href")
                        }
                    } else {
                        // tidak ada direct link pdf
                        obj.free = false
                    }

                    // console.log(obj)

                    // push
                    if(obj.abstract != 'no-abs')
                        crawlInfo.search_res_links.push({
                            index: i + ((crawlInfo.pageNum * 10) - 10),
                            g_id: $(".gs_ri > .gs_rt > a").attr("data-clk-atid"),
                            title: $(".gs_ri > .gs_rt > a").text(),
                            abstract: obj.abstract,
                            keywords: obj.keywords,
                            full_text: '-',
                            references_count: 0,
                            content: obj.content,
                            cited_count: obj.cited_count.substring(9),
                            authors: obj.authors,
                            publisher: obj.publisher,
                            publish_year: obj.publish_year,
                            site: obj.site,
                            free: obj.free,
                            link: obj.link,
                            pdf: obj.pdf,
                            value: 0
                        })
                } catch (e) {
                    console.log(e)
                    console.log("Link : " + $(".gs_ri > .gs_rt > a").attr("href"))
                    if($(".gs_ri > .gs_rt > a").attr("href")) {
                        if($(".gs_ri > .gs_rt > a").attr("href").includes('.pdf')
                            || $(".gs_ri > .gs_rt > a").attr("href").includes('download')
                            || $(".gs_ri > .gs_rt > a").attr("href").includes('document')
                            || $(".gs_ri > .gs_rt > a").attr("href").includes('view')
                            || $(".gs_ri > .gs_rt > a").attr("href").includes('index.php')){
                            console.log("Skiped .pdf extension or not a website")
                        } else{
                            console.log(e)
                        }
                    }
                }
            }
        }
    }

    if(crawlInfo.pageNum < MAX_PAGE) {
        // next page
        crawlInfo.pageNum++
        return await googleScholarCrawl(browser, page, keyword, crawlInfo)
    }

    return crawlInfo.search_res_links
}


// scd crawler setup
const POSSIBLE_FULL_TEXT_REMOVAL = [
    'authorship',
    'Authorship',
    'Author contributions',
    'CRediT authorship'
]
const MAX_PAGE_SCD = 3 // per page 100
const MAX_NULL_RESET = 3

// target 'https://www.sciencedirect.com'
async function scienceDirectCrawl(browser, page, keyword, crawlInfo) {
    console.log("Page num : " + crawlInfo.pageNum)
    
    await Promise.all([
        page.waitForNavigation(),
        page.goto(`https://www.sciencedirect.com/search?qs=${keyword}&date=${crawlInfo.date}&accessTypes=openaccess&show=100&offset=${((crawlInfo.pageNum * 100) - 100)}`, {
            waitUntil: 'domcontentloaded'
        }),
        page.waitForSelector('ol.search-result-wrapper > li'),
    ])

    const pageURL = page.url()

    let searchResRaw = ''
    try{
        searchResRaw = await page.$$eval("ol.search-result-wrapper > li", (results) => {
            const temp = []
            for (let i = 0; i < results.length; i++) {
                // dapatin html
                temp.push(results[i].innerHTML + "")
            }
            return temp
        })
    }catch (e) {
        console.log("error load html page : " + e)
        console.log("reseting page : " + crawlInfo.pageNum)
        // try to reset this page
        await browser.close()
        browser = await puppeteer.launch({
            'args' : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized'
            ],
            defaultViewport: null,
            headless: true
        })
        page = await browser.newPage()
        crawlInfo.attempt++

        return scienceDirectCrawl(browser, page, keyword, crawlInfo)
    }

    if(searchResRaw.length === 0) {
        // try to reset this page
        if (crawlInfo.attempt < MAX_NULL_RESET) {
            console.log("reset page")
            crawlInfo.attempt++

            await browser.close()
            browser = await puppeteer.launch({
                'args' : [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--start-maximized'
                ],
                defaultViewport: null,
                headless: true
            })
            page = await browser.newPage()
    
            return scienceDirectCrawl(browser, page, keyword, crawlInfo)
        }
        return crawlInfo.search_res_links
    }

    for (let i = 0; i < searchResRaw.length; i++) {
        if (crawlInfo.search_res_links.length >= MAX_CRAWL_DATA) {
            return crawlInfo.search_res_links
        }
        const $ = await cheerio.load(searchResRaw[i] + "")

        // prevent yang bukan journal
        if (!$('.login-message-container').text().includes('personalized search experience')) {
            const detailJournalPath = $("a.result-list-title-link").attr("href")
            console.log(detailJournalPath)
    
            // obtaining journal info detail
            try {
                // masuk ke detail journal
                await page.goto(pageURL.substring(0, pageURL.indexOf('/', 10)) + detailJournalPath, {
                    timeout: 8000,
                    waitUntil: 'load'
                })

                await sleep(1250)
    
                const body = await page.$eval(`.Article`, (result) => {
                    return result.innerHTML
                })
                
                const jq = await cheerio.load(body + "")
    
                if (!jq(".PdfEmbed").text()) {
                    const tempAuthors = $(".Authors").text()
                    let authors = tempAuthors.charAt(0)
                    for (let i = 1; i < tempAuthors.length; i++) {
                        if (tempAuthors.charAt(i).toUpperCase() === tempAuthors.charAt(i) && tempAuthors.charAt(i - 1) !== ' ' && tempAuthors.charAt(i) !== ' ' && tempAuthors.charAt(i - 1).toUpperCase() !== tempAuthors.charAt(i - 1)) {
                            authors += ', '
                        } 
                        authors += tempAuthors.charAt(i)
                    }
        
                    const publishYear = $(".srctitle-date-fields").text().slice(-4)
    
                    const tempKey = jq(".keywords-section").text()
                    
                    let keywords = tempKey.charAt(0)
                    for (let i = 1; i < tempKey.length; i++) {
                        if (tempKey.charAt(i).toUpperCase() === tempKey.charAt(i) && tempKey.charAt(i - 1) !== ' ' && tempKey.charAt(i - 1).toUpperCase() !== tempKey.charAt(i - 1)) {
                            keywords += ' '
                        } 
                        keywords += tempKey.charAt(i)
                    }
                    keywords = keywords.replaceAll('Keywords', '')
                    keywords = keywords.replaceAll('(', '')
                    keywords = keywords.replaceAll(')', '')
                    keywords = keywords.replace(/\s\s+/g, ' ')
                    
                    const citedCount = jq("#citing-articles-header").text().substring(jq("#citing-articles-header").text().indexOf('(') + 1, jq("#citing-articles-header").text().indexOf(')'))
        
                    let fullText = jq("#body > div").text()
                    let ctr = -1
                    for (let i = 0; i < POSSIBLE_FULL_TEXT_REMOVAL.length; i++) {
                        ctr = fullText.indexOf(POSSIBLE_FULL_TEXT_REMOVAL[i] + '')
                        if(ctr != -1) {
                            break
                        }
                    }
                    if(ctr > 0) {
                        fullText.length = ctr
                    }
    
                    fullText = fullText.replaceAll('\n', ' ')
                    fullText = fullText.replaceAll('\t', ' ')
                    fullText = fullText.replaceAll(',', ' ')
                    fullText = fullText.replaceAll('1. Introduction', '')
                    fullText = fullText.replaceAll('.', ' ')
                    fullText = fullText.replaceAll(':', '')
                    fullText = fullText.replaceAll('(', '')
                    fullText = fullText.replaceAll(')', '')
                    fullText = fullText.replace(/\s\s+/g, ' ')

                    const abstract = jq(".abstract.author > div > p").text()
                    const spl = abstract.split('.')
                    let content = ''
                    ctr = 0
                    for (let i = 0; i < spl.length && ctr < 2; i++) {
                        if(spl[i].toLowerCase().includes(crawlInfo.simpleKeyword.toLowerCase())) {
                            ctr++ 
                            content += '...' + spl[i]
                        }
                    }
                    if (ctr == 0) {
                        content += spl[0]
                    }
                    content += '...'
                    
                    if (abstract.length > 0 && fullText.length > 0) {
                        crawlInfo.search_res_links.push({
                            index: i + ((crawlInfo.pageNum * 100) - 100),
                            g_id: detailJournalPath.slice(-17),
                            title: jq(".title-text").text(),
                            abstract: abstract,
                            keywords: keywords,
                            full_text: fullText,
                            references_count: jq(".reference").length,
                            content: content,
                            cited_count: citedCount,
                            authors: authors,
                            publisher: 'Elsevier',
                            publish_year: publishYear,
                            site: 'Elsevier',
                            free: true,
                            link: jq(".doi").text(),
                            pdf: pageURL.substring(0, pageURL.indexOf('/', 10)) + jq("a:contains('PDF')").attr("href"),
                            value: 0
                        })
                    }
                }
            } catch (error) {
                console.log("error obtaining journal info i-" + (i + 1))
                console.log(error)
            }
        }
    }
    
    if(crawlInfo.pageNum < MAX_PAGE_SCD) {
        // next page
        crawlInfo.pageNum++
        return await scienceDirectCrawl(browser, page, keyword, crawlInfo)
    }

    return crawlInfo.search_res_links
}


// ieee crawler setup
const MAX_PAGE_IEEE = 10 // per page 10

// target 'https://ieeexplore.ieee.org'
async function ieeeCrawl(browser, page, keyword, crawlInfo) {
    console.log("Page num : " + crawlInfo.pageNum)
    
    await Promise.all([
        page.waitForNavigation(),
        page.goto(`https://ieeexplore.ieee.org/search/searchresult.jsp?queryText=${keyword}&highlight=true&returnType=SEARCH&matchPubs=true&rowsPerPage=10&pageNumber=${crawlInfo.pageNum}&openAccess=true&refinements=ContentType:Journals${crawlInfo.date}&returnFacets=ALL`, {
            waitUntil: 'domcontentloaded'
        }),
        page.waitForSelector('.List-results-items'),
    ])

    const pageURL = page.url()

    let searchResRaw = ''
    try{
        searchResRaw = await page.$$eval(".List-results-items", (results) => {
            const temp = []
            for (let i = 0; i < results.length; i++) {
                // dapatin html
                temp.push(results[i].innerHTML + "")
            }
            return temp
        })
    }catch (e) {
        console.log("error load html page : " + e)
        console.log("reseting page : " + crawlInfo.pageNum)
        // try to reset this page
        await browser.close()
        browser = await puppeteer.launch({
            'args' : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized'
            ],
            defaultViewport: null,
            headless: true
        })
        page = await browser.newPage()
        crawlInfo.attempt++

        return ieeeCrawl(browser, page, keyword, crawlInfo)
    }

    if(searchResRaw.length === 0) {
        // try to reset this page
        if (crawlInfo.attempt < MAX_NULL_RESET) {
            console.log("reset page")
            crawlInfo.attempt++

            await browser.close()
            browser = await puppeteer.launch({
                'args' : [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--start-maximized'
                ],
                defaultViewport: null,
                headless: true
            })
            page = await browser.newPage()
    
            return ieeeCrawl(browser, page, keyword, crawlInfo)
        }
        return crawlInfo.search_res_links
    }

    for (let i = 0; i < searchResRaw.length; i++) {
        if (crawlInfo.search_res_links.length >= MAX_CRAWL_DATA) {
            return crawlInfo.search_res_links
        }
        const $ = await cheerio.load(searchResRaw[i] + "")

        const detailJournalPath = $("a:contains('HTML')").attr("href")
        console.log(detailJournalPath)

        if(detailJournalPath !== undefined) {
            try {
                // masuk ke detail journal
                await Promise.all([
                    page.waitForNavigation(),
                    page.goto(pageURL.substring(0, pageURL.indexOf('/', 10)) + detailJournalPath + 'references#references', {
                        timeout: 15000,
                        waitUntil: 'domcontentloaded'
                    }),
                    page.waitForSelector('.document-main'),
                ])

                let body = await page.$eval(`.document-main`, (result) => {
                    return result.innerHTML
                })
                
                let jq = await cheerio.load(body + "")

                const referenceCount = Math.ceil(jq("div.reference-container").length / 2)

                await page.click("#keywords-header", {clickCount:1})
    
                body = await page.$eval(`.document-main`, (result) => {
                    return result.innerHTML
                })
                
                jq = await cheerio.load(body + "")

                let keywords = jq("li:contains('Author')").text()
                if (keywords.length === 0) {
                    keywords = jq(".doc-keywords-list-item").text()
                }
                keywords = keywords.replaceAll('Author', '')
                keywords = keywords.replaceAll('IEEE', '')
                keywords = keywords.replaceAll('Keywords', '')
                keywords = keywords.replaceAll(',', ' ')
                keywords = keywords.replace(/\s\s+/g, ' ')

                const id = detailJournalPath.substring(10, 17)

                let abstract = jq(".abstract-text.row").text()
                abstract = abstract.replaceAll('Abstract', '')
                abstract = abstract.replaceAll(':', '')
                abstract = abstract.replaceAll('\n', '')
                abstract = abstract.replaceAll('(', '')
                abstract = abstract.replaceAll(')', '')

                const spl = abstract.split('.')
                let content = ''
                let ctr = 0
                for (let i = 0; i < spl.length && ctr < 2; i++) {
                    if(spl[i].toLowerCase().includes(crawlInfo.simpleKeyword.toLowerCase())) {
                        ctr++ 
                        content += '...' + spl[i]
                    }
                }
                if (ctr == 0) {
                    content += spl[0]
                }
                content += '...'

                let authors = $('p.author').text()
                authors = authors.replaceAll(';', ', ')

                let fullText = ""
                for (let i = 0; i < 20; i++) {
                    fullText += jq("#article > #sec" + (i + 1)).text()
                }
                fullText = fullText.replaceAll('\n', ' ')
                fullText = fullText.replaceAll('\t', '')
                fullText = fullText.replace(/section/gi, '')
                fullText = fullText.replaceAll('.', ' ')
                fullText = fullText.replaceAll(',', ' ')
                fullText = fullText.replaceAll(';', ' ')
                fullText = fullText.replaceAll('(', '')
                fullText = fullText.replaceAll(')', '')
                fullText = fullText.replace(/\s\s+/g, ' ')

                let publishYear = jq(".doc-abstract-pubdate").text().slice(-5)
                publishYear = publishYear.replaceAll(' ', '')
                
                if (abstract.length > 0 && fullText.length > 0) {
                    crawlInfo.search_res_links.push({
                        index: i + ((crawlInfo.pageNum * 10) - 10),
                        g_id: id,
                        title: jq(".document-title").text(),
                        abstract: abstract,
                        keywords: keywords,
                        full_text: fullText,
                        references_count: referenceCount,
                        content: content,
                        cited_count: jq(".document-banner-metric-count").first().text(),
                        authors: authors,
                        publisher: 'IEEE',
                        publish_year: publishYear,
                        site: 'ieeexplore.ieee.org',
                        free: true,
                        link: jq(".stats-document-abstract-doi > a").attr("href"),
                        pdf: pageURL.substring(0, pageURL.indexOf('/', 10)) + jq("a:contains('PDF')").attr("href"),
                        value: 0
                    })
                }
            }catch (e) {
                console.log('error load detail : ' + (i + 1))
                console.log(e)
            }
        }
    }

    
    if(crawlInfo.pageNum < MAX_PAGE_IEEE) {
        // next page
        crawlInfo.pageNum++
        return await ieeeCrawl(browser, page, keyword, crawlInfo)
    }

    return crawlInfo.search_res_links
}


// ACD crawler setup
const MAX_PAGE_ACD = 10 // per page 20

async function recaptchaSolverACD (browser, page, keyword, crawlInfo) {
    try{
        if(crawlInfo.attempt == MAX_RESET) {
            return "Reach Maximum Callback Reset"
        }
        const recaptcha = await page.$eval(`body`, (result) => {
            return result.innerHTML
        })
        const $ = await cheerio.load(recaptcha + "")

        if ($('.explanation-message').text().length > 0) {
            // reset
            crawlInfo.attempt++

            return academicCrawl(browser, page, keyword, crawlInfo)
        }
    } catch (e) {
        console.log("error recaptcha : " + e)
    }
}

// target 'https://academic.oup.com'
async function academicCrawl(browser, page, keyword, crawlInfo) {
    console.log("Page num : " + crawlInfo.pageNum)

    await page.goto(`https://academic.oup.com/journals/search-results?${keyword}&allJournals=1&f_ContentType=Journal+Article&fl_SiteID=5567&access_openaccess=true&page=${crawlInfo.pageNum}&${crawlInfo.date}`, {
        waitUntil: 'domcontentloaded'
    })

    await sleep(250)

    await recaptchaSolverACD (browser, page, keyword, crawlInfo)

    const pageURL = page.url()
    
    let searchResRaw = ''
    try{
        searchResRaw = await page.$$eval(".sr-list.al-article-box", (results) => {
            const temp = []
            for (let i = 0; i < results.length; i++) {
                // dapatin html
                temp.push(results[i].innerHTML + "")
            }
            return temp
        })
    }catch (e) {
        console.log("error load html page : " + e)
        console.log("reseting page : " + crawlInfo.pageNum)
        // try to reset this page
        await browser.close()
        browser = await puppeteer.launch({
            'args' : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized'
            ],
            defaultViewport: null,
            headless: true
        })
        page = await browser.newPage()
        crawlInfo.attempt++

        return academicCrawl(browser, page, keyword, crawlInfo)
    }

    if(searchResRaw.length === 0) {
        return crawlInfo.search_res_links
    }

    for (let i = 0; i < searchResRaw.length; i++) {
        if (crawlInfo.search_res_links.length >= MAX_CRAWL_DATA) {
            return crawlInfo.search_res_links
        }
        const $ = await cheerio.load(searchResRaw[i] + "")

        const detailJournalPath = $(".article-link").attr("href")
        console.log(detailJournalPath)

        if(detailJournalPath) {
            try {
                // masuk ke detail journal
                await Promise.all([
                    page.waitForNavigation(),
                    page.goto(pageURL.substring(0, pageURL.indexOf('/', 10)) + detailJournalPath, {
                        waitUntil: 'domcontentloaded'
                    }),
                    page.waitForSelector('.content-main'),
                ])
    
                const body = await page.$eval(`.content-main`, (result) => {
                    return result.innerHTML
                })
                
                const jq = await cheerio.load(body + "")

                if (jq(".pdf-notice").text().length === 0) {
                    let title = jq(".wi-article-title").text()
                    title = title.replaceAll('\n', '')
                    title = title.replace(/\s\s+/g, ' ')
    
                    let abstract = jq(".abstract").text()
                    abstract = abstract.replaceAll('\n', '')
                    abstract = abstract.replaceAll('.', ' ')
                    abstract = abstract.replaceAll(',', ' ')
                    abstract = abstract.replaceAll(';', ' ')
                    abstract = abstract.replaceAll('(', '')
                    abstract = abstract.replaceAll(')', '')
                    abstract = abstract.replace(/\s\s+/g, ' ')
    
                    let fullText = ""
                    jq(".chapter-para").map((i, card) => {
                        if (!abstract.includes($(card).text())) {
                            fullText += $(card).text() + ' '
                        }
                    })
                    fullText = fullText.replaceAll('\n', '')
                    fullText = fullText.replaceAll('.', ' ')
                    fullText = fullText.replaceAll(',', ' ')
                    fullText = fullText.replaceAll(';', ' ')
                    fullText = fullText.replaceAll('(', '')
                    fullText = fullText.replaceAll(')', '')
                    fullText = fullText.replace(/\s\s+/g, ' ')
    
                    let keywords = jq(".kwd-group").text()
                    keywords = keywords.replaceAll(',', '')
    
                    let content = $('.snippet').text()
                    content = content.replaceAll('\n', ' ')
                    content = content.replace(/\s\s+/g, ' ')

                    let citedCount = 0
                    if (jq(".__db_score_normal").text().length > 0) {
                        citedCount = jq(".__db_score_normal").text()
                    }
                    
                    if (abstract.length > 0 && fullText.length > 0) {
                        crawlInfo.search_res_links.push({
                            index: i + ((crawlInfo.pageNum * 20) - 20),
                            g_id: jq("a:contains('https://doi.org')").attr("href").substring(24),
                            title: title,
                            abstract: abstract,
                            keywords: keywords,
                            full_text: fullText,
                            references_count: jq(".js-splitview-ref-item").length,
                            content: content,
                            cited_count: citedCount,
                            authors: $('.sri-authors').text(),
                            publisher: 'Oxford Academic',
                            publish_year: $(".sri-date").text().slice(-4),
                            site: 'academic.oup.com',
                            free: true,
                            link: jq("a:contains('https://doi.org')").attr("href"),
                            pdf: pageURL.substring(0, pageURL.indexOf('/', 10)) + jq(".pdf").attr("href"),
                            value: 0
                        })
                    }
                }
            }catch (e) {
                console.log('error load detail : ' + (i + 1))
                console.log(e)
            }
        }
    }

    
    if(crawlInfo.pageNum < MAX_PAGE_ACD) {
        // next page
        crawlInfo.pageNum++
        return await academicCrawl(browser, page, keyword, crawlInfo)
    }

    return crawlInfo.search_res_links
}


// CRAWLER HELPER
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function findDash(text, start) {
    let index = start
    let flag = false
    do {
        if(text.substr(text.indexOf('-', index) - 1, 3).indexOf(" ") == -1) {
            index = text.indexOf('-', index) + 1
            flag = true
        } else {
            index = text.indexOf('-', index)
            flag = false
        }
    } while(flag)
    return parseInt(index)
}


// API Testing  scholar crawler
router.post('/googlescholar', async(req,res)=> {
    if(req.body.keyword){
        try{
            let crawlInfo = {
                search_res_links: [],
                pageNum : 1,
                attempt : 1,
                yearStart: '',
                yearEnd: ''
            }
            const browser = await puppeteer.launch({
                'args' : [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--start-maximized',
                ],
                defaultViewport: null,
                headless: true
            })
            const page = await browser.newPage()

            const searchResLinks = await googleScholarCrawl(browser, page, req.body.keyword, crawlInfo)

            // await browser.close()

            cosineSimilarity(searchResLinks, req.body.keyword, 1)

            cosineSimilarity(searchResLinks, req.body.keyword, 2)

            return res.status(200).json({
                'message': 'Crawl Berhasil!',
                'data': {searchResLinks},
                'data2': {cosine},
                'status': 'Success'
            });
        }catch(e) {
            console.log(e)
            return res.status(501).json({
                'message': 'Error crawling',
                'data':{e
                },
                'status': 'Error'
            });
        }
    }else{
        return res.status(401).json({
            'message': 'Inputan Belum lengkap!',
            'data':{
            },
            'status': 'Error'
        });
    }
});

// API Testing another crawl
router.post('/scd', async (req, res) => {
    try{
        let yearStart = '-'
        let yearEnd = '-'
        let date = ''
        if(yearStart !== '-' && yearEnd !== '-') {
            date = yearStart + '-' + yearEnd
        } else if (yearStart !== '-') {
            date = yearStart 
        } else if (yearEnd !== '-') {
            date = yearEnd 
        }

        let crawlInfo = {
            search_res_links: [],
            pageNum : 1,
            attempt : 1,
            date: date,
            simpleKeyword: req.body.keyword
        }
        MAX_CRAWL_DATA = 40
        const browser = await puppeteer.launch({
            'args' : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized',
            ],
            defaultViewport: null,
            headless: true
        })
        const page = await browser.newPage()

        let results = await scienceDirectCrawl(browser, page, req.body.keyword, crawlInfo)

        await browser.close()

        let cosinusKeyword = req.body.simple + " " + req.body.factor1 + " " + req.body.factor2
        cosinusKeyword.toLowerCase()
    
        // cosinus sim 2 after cosineSimilarity
        journalsEvaluation(results, cosinusKeyword, req.body.simple, req.body.factor1 + " " + req.body.factor2, 1)
    
        // ranking with KMA
        results = KMA(results, results.length, Math.ceil(results.length / 2) + 5, 100, 5)
        let finalResult = []
        let titleOnly = []
        for(let i = 0; i < results.length; i++) {
            titleOnly.push(results[i].journal.title)
            finalResult.push({
                "index": results[i].journal.index,
                "title": results[i].journal.title,
                "abstractVal": results[i].journal.abstractVal,
                "keywordsVal": results[i].journal.keywordsVal,
                "fullTextVal": results[i].journal.fullTextVal,
                "referencesVal": results[i].journal.referencesVal,
                "citedVal": results[i].journal.citedVal,
                "factorSenSim": results[i].journal.factorSenSim,
                "factorSF": results[i].journal.factorSF,
                "factor": results[i].journal.factor,
                "value1": results[i].journal.value1,
                "value2": results[i].journal.value2,
                "value3": results[i].journal.value3,
                "x": results[i].x,
                "y": results[i].y,
                "z": results[i].z,
                "fitness": results[i].fitness,
            })
        }

        return res.status(200).json({
            'message': 'Crawl Berhasil!',
            'titleOnly': titleOnly,
            'data': {finalResult},
            'results': {results},
            'status': 'Success'
        });
    }catch(e) {
        console.log(e)
        return res.status(501).json({
            'message': 'Error crawling',
            'data':{e
            },
            'status': 'Error'
        });
    }
});

// API Testing ieee
router.post('/ieee', async (req, res) => {
    try{
        let keyword = req.body.keyword
        let yearStart = '-'
        let yearEnd = '-'
        let date = ''
        if(yearStart !== '-' && yearEnd !== '-') {
            date = `&ranges=${yearStart}_${yearEnd}_Year`
        } else if (yearStart !== '-') {
            date = `&ranges=${yearStart}_${yearStart}_Year`
        } else if (yearEnd !== '-') {
            date = `&ranges=${yearEnd}_${yearEnd}_Year`
        }

        let crawlInfo = {
            search_res_links: [],
            pageNum : 1,
            attempt : 1,
            date: date,
            simpleKeyword: req.body.simple
        }
        const browser = await puppeteer.launch({
            'args' : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized',
            ],
            defaultViewport: null,
            headless: true
        })
        const page = await browser.newPage()

        let results = await ieeeCrawl(browser, page, keyword, crawlInfo)

        await browser.close()

        let cosinusKeyword = req.body.simple + " " + req.body.factor1 + " " + req.body.factor2
        cosinusKeyword.toLowerCase()
    
        // cosinus sim 2 after cosineSimilarity
        journalsEvaluation(results, cosinusKeyword, req.body.simple, req.body.factor1, 2)
    
        // ranking with KMA
        results = KMA(results, results.length, Math.ceil(results.length / 2) + 5, 100, 5, 2)
        let finalResult = []
        let titleOnly = []
        for(let i = 0; i < results.length; i++) {
            titleOnly.push(results[i].journal.title)
            finalResult.push({
                "index": results[i].journal.index,
                "title": results[i].journal.title,
                "abstractVal": results[i].journal.abstractVal,
                "keywordsVal": results[i].journal.keywordsVal,
                "fullTextVal": results[i].journal.fullTextVal,
                "referencesVal": results[i].journal.referencesVal,
                "citedVal": results[i].journal.citedVal,
                "factorSenSim": results[i].journal.factorSenSim,
                "factorSF": results[i].journal.factorSF,
                "factor": results[i].journal.factor,
                "value1": results[i].journal.value1,
                "value2": results[i].journal.value2,
                "value3": results[i].journal.value3,
                "x": results[i].x,
                "y": results[i].y,
                "z": results[i].z,
                "fitness": results[i].fitness,
            })
        }

        return res.status(200).json({
            'message': 'Crawl Berhasil!',
            'titleOnly': titleOnly,
            'data': {finalResult},
            'results': {results},
            'status': 'Success'
        });
    }catch(e) {
        console.log(e)
        return res.status(501).json({
            'message': 'Error crawling',
            'data':{e
            },
            'status': 'Error'
        });
    }
});

// API Testing acd
router.post('/acd', async (req, res) => {
    try{
        let keyword = 'q=' + req.body.keyword
        let yearStart = '2021'
        let yearEnd = '-'
        let date = ''
        if(yearStart !== '-' && yearEnd !== '-') {
            date = `&rg_ArticleDate=01/01/${yearStart}%20TO%2012/31/${yearEnd}&dateFilterType=range&noDateTypes=true&rg_SearchResultsPublicationDate=01/01/${yearStart}%20TO%2012/31/${yearEnd}&rg_VersionDate=01/01/${yearStart}%20TO%2012/31/${yearEnd}`
        } else if (yearStart !== '-') { 
            date = `&rg_ArticleDate=01/01/${yearStart}%20TO%2012/31/2999&dateFilterType=range&noDateTypes=true&rg_SearchResultsPublicationDate=01/01/${yearStart}%20TO%2012/31/2999&rg_VersionDate=01/01/${yearStart}%20TO%2012/31/2999`
        } else if (yearEnd !== '-') {
            date = `&rg_ArticleDate=01/01/1980%20TO%2012/31/${yearEnd}&dateFilterType=range&noDateTypes=true&rg_SearchResultsPublicationDate=01/01/1980%20TO%2012/31/${yearEnd}&rg_VersionDate=01/01/1980%20TO%2012/31/${yearEnd}`
        }
        

        let crawlInfo = {
            search_res_links: [],
            pageNum : 1,
            attempt : 1,
            date: date
        }
        const browser = await puppeteer.launch({
            'args' : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized',
            ],
            defaultViewport: null,
            headless: true
        })
        const page = await browser.newPage()

        let results = await academicCrawl(browser, page, keyword, crawlInfo)

        await browser.close()

        let cosinusKeyword = req.body.simple + " " + req.body.factor1 + " " + req.body.factor2
        cosinusKeyword.toLowerCase()
    
        // cosinus sim 2 after cosineSimilarity
        journalsEvaluation(results, cosinusKeyword, req.body.simple, req.body.factor1 + " " + req.body.factor2, 3)
    
        // ranking with KMA
        results = KMA(results, results.length, Math.ceil(results.length / 2) + 5, 100, 5, 2)
        let finalResult = []
        let titleOnly = []
        for(let i = 0; i < results.length; i++) {
            titleOnly.push(results[i].journal.title)
            finalResult.push({
                "index": results[i].journal.index,
                "title": results[i].journal.title,
                "abstractVal": results[i].journal.abstractVal,
                "keywordsVal": results[i].journal.keywordsVal,
                "fullTextVal": results[i].journal.fullTextVal,
                "referencesVal": results[i].journal.referencesVal,
                "citedVal": results[i].journal.citedVal,
                "factorSenSim": results[i].journal.factorSenSim,
                "factorSF": results[i].journal.factorSF,
                "factor": results[i].journal.factor,
                "value1": results[i].journal.value1,
                "value2": results[i].journal.value2,
                "value3": results[i].journal.value3,
                "x": results[i].x,
                "y": results[i].y,
                "z": results[i].z,
                "fitness": results[i].fitness,
            })
        }

        return res.status(200).json({
            'message': 'Crawl Berhasil!',
            'titleOnly': titleOnly,
            'data': {finalResult},
            'results': {results},
            'status': 'Success'
        });
    }catch(e) {
        console.log(e)
        return res.status(501).json({
            'message': 'Error crawling',
            'data':{e
            },
            'status': 'Error'
        });
    }
});




// Normalized Term Frequency and Inverse Document Frequency (IDF), mode 1 : abstract, 2 keywords
function cosineSimilarity(docs, query, mode = 1) {
    const qWords = query.split(" ")
    let ALL_DOCS_TF = [] // Setiap kata dari setiap dokumen, bisa ada mengandung kata yang sama dari antar dokumen (tetapi doc id beda)
    let allWords = [] // isi semua kata dari semua dokumen (tidak ada yang sama)

    // normalisasi TF Semua document
    for (let i = 0; i < docs.length; i++) {
        let words = '-'
        if (mode == 1) {
            docs[i].abstract.toLowerCase()
            words = docs[i].abstract.split(" ")
        } else if (mode == 2) {
            docs[i].keywords.toLowerCase()
            words = docs[i].keywords.split(" ")
        } else if (mode == 3) {
            docs[i].full_text.toLowerCase()
            words = docs[i].full_text.split(" ")
        }
        const res = []

        // setiap kata di dalam doc, dihitung frekuensinya (ctr)
        for (let j = 0; j < words.length; j++) {
            let flag = true
            for (let k = 0; k < res.length; k++) {
                // apakah kata ini sudah pernah dipush
                if (words[j] == res[k].text){
                    // jika ya tambahin ctr
                    res[k].ctr++
                    flag = false
                    break
                }
            }

            if (flag) {
                // jika tidak (flag = true), push
                res.push({
                    originDocIdx: i,
                    text: words[j],
                    ctr: 1
                })
            }
        }

        for (let j = 0; j < res.length; j++) {
            // normalisasi
            res[j].tf = (res[j].ctr * 1.0 / words.length)

            // untuk dapatin semua kata dalam dokumen (yang berbeda semua)
            let flag = true
            for (let k = 0; k < allWords.length; k++) {
                if(res[j].text == allWords[k]) {
                    flag = false
                    break
                }
            }

            if (flag) {
                allWords.push(res[j].text)
            }

            ALL_DOCS_TF.push(res[j])
        }
    }

    // cari TF query
    const queryTF = []
    for (let j = 0; j < qWords.length; j++) {
        let flag = true
        for (let k = 0; k < queryTF.length; k++) {
            // apakah kata ini sudah pernah dipush
            if (qWords[j] == queryTF[k].text){
                // jika ya tambahin ctr
                queryTF[k].ctr++
                flag = false
                break
            }
        }

        if (flag) {
            // jika tidak (flag = true), push
            queryTF.push({
                text: qWords[j],
                ctr: 1
            })
        }
    }
    // normalisasi TF query
    for (let j = 0; j < queryTF.length; j++) {
        queryTF[j].tf = (queryTF[j].ctr * 1.0 / qWords.length)
    }


    // norm TF * IDF
    let docQueryTFxIDF = []
    for (let j = 0; j < queryTF.length; j++) {
        for (let i = 0; i < allWords.length; i++) {
            if(allWords[i] == queryTF[j].text) {
                let ctr = 0
                for (let k = 0; k < ALL_DOCS_TF.length; k++) {
                    if (ALL_DOCS_TF[k].text == allWords[i]) {
                        // hitung berapa banyak kata ini muncul di semua dokumen (setiap DOKUMEN pasti hanya mengandung 1 atau tidak sama sekali)
                        ctr++
                    }
                }

                // query IDF value
                queryTF[j].idf_val = 1.0 + Math.log(docs.length * 1.0 / ctr)

                // query normTF * IDF value
                queryTF[j].normTFxIDFval = queryTF[j].tf * queryTF[j].idf_val * 1.0

                // docQueryTFxIDF diisi dengan semua ALL_DOCS_TF yang text nya queryTF[j].text (ambil queryTF[j].text dari seluruh dokumen yang mengandung)
                for (let k = 0; k < ALL_DOCS_TF.length; k++) {
                    if(allWords[i] == ALL_DOCS_TF[k].text) {
                        // IDF value
                        ALL_DOCS_TF[k].idf_val = 1.0 + Math.log(docs.length * 1.0 / ctr)

                        // normTF * IDF
                        ALL_DOCS_TF[k].normTFxIDFval = ALL_DOCS_TF[k].tf * ALL_DOCS_TF[k].idf_val * 1.0
                        docQueryTFxIDF.push(ALL_DOCS_TF[k])
                    }
                }

                break
            }
        }
    }

    // calculate cosine similarity
    calcCosineSimilarity(docs, docQueryTFxIDF, queryTF, mode)
}

function calcCosineSimilarity (docs, docQueryTFxIDF, queryTF, mode) {
    // console.log(docQueryTFxIDF)
    // console.log("===========")
    // console.log(queryTF)
    let sqrtQuery = 0.0
    for (let i = 0; i < queryTF.length; i++) {
        if(queryTF[i].normTFxIDFval) {
            sqrtQuery += (queryTF[i].normTFxIDFval * queryTF[i].normTFxIDFval * 1.0)
        }
    }
    sqrtQuery = Math.sqrt(sqrtQuery)

    for (let i = 0; i < docs.length; i++) {
        let dotProduct = 0.0
        let sqrtDoc = 0.0

        for (let j = 0; j < docQueryTFxIDF.length; j++) {
            if(docQueryTFxIDF[j].originDocIdx == i && docQueryTFxIDF[j].normTFxIDFval) {
                sqrtDoc += (docQueryTFxIDF[j].normTFxIDFval * docQueryTFxIDF[j].normTFxIDFval * 1.0)

                for (let k = 0; k < queryTF.length; k++) {
                    if(docQueryTFxIDF[j].text == queryTF[k].text) {
                        dotProduct += (docQueryTFxIDF[j].normTFxIDFval * queryTF[k].normTFxIDFval * 1.0)
                        break
                    }
                }
            }
        }
        sqrtDoc = Math.sqrt(sqrtDoc)

        if (mode == 1) {
            docs[i].abstractCos = 0
            if (dotProduct != 0) {
                docs[i].abstractCos = (dotProduct / (sqrtDoc * sqrtQuery))
                if(docs[i].abstractCos > 1.0) {
                    docs[i].abstractCos = 1
                }
            }
        } else if (mode == 2 ) {
            docs[i].keywordsCos = 0
            if (dotProduct != 0) {
                docs[i].keywordsCos = (dotProduct / (sqrtDoc * sqrtQuery))
                if(docs[i].keywordsCos > 1.0) {
                    docs[i].keywordsCos = 1
                }
            }
        } else {
            docs[i].fullTextCos = 0
            if (dotProduct != 0) {
                docs[i].fullTextCos = (dotProduct / (sqrtDoc * sqrtQuery))
                if(docs[i].fullTextCos > 1.0) {
                    docs[i].fullTextCos = 1
                }
            }
        }
    }
}

const ALPHA = 0.2
const PENALTY_TRESHOLD = 0.7
// require cosine similarity first
function journalsEvaluation (docs, cosinusKeyword, simpleKeyword, sfKeyword, crawlerOpt) {
    // sentence similarity, secara literal
    const maxAbsSenSim = sentenceSimilarity(docs, simpleKeyword, 1)
    const maxKeySenSim = sentenceSimilarity(docs, simpleKeyword, 2)
    const maxFtSenSim = sentenceSimilarity(docs, simpleKeyword, 3)

    const abstracts = []
    const keywords = []
    const fullTexts = []
    let maxRef = 1
    let maxCited = 1
    for (let i = 0; i < docs.length; i++) {
        abstracts.push(docs[i].abstract)
        keywords.push(docs[i].keywords)
        fullTexts.push(docs[i].full_text)

        if(docs[i].references_count > maxRef){
            maxRef = docs[i].references_count
        }

        if(parseInt(docs[i].cited_count) > maxCited){
            maxCited = parseInt(docs[i].cited_count)
        }
    }

    // cosine similarity dengan cosineKeyword, handmade first
    cosineSimilarity(docs, cosinusKeyword, 1)
    cosineSimilarity(docs, cosinusKeyword, 2)
    cosineSimilarity(docs, cosinusKeyword, 3)

    // cosinus similarity npm dengan cosinusKeyword
    let tf_idf_abs = new TfIdf()
    let tf_idf_key = new TfIdf()
    let tf_idf_ft = new TfIdf()
    tf_idf_abs.createCorpusFromStringArray(abstracts)
    tf_idf_key.createCorpusFromStringArray(keywords)
    tf_idf_ft.createCorpusFromStringArray(fullTexts)

    let search_result = tf_idf_abs.rankDocumentsByQuery(cosinusKeyword)
    for (let i = 0; i < search_result.length; i++) {
        docs[search_result[i].index].factorSenSimAbs = (docs[search_result[i].index].abstractSenSim / maxAbsSenSim)
        docs[search_result[i].index].abstractVal = (search_result[i].similarityIndex + docs[search_result[i].index].abstractCos) * 0.5
    }

    search_result = tf_idf_key.rankDocumentsByQuery(cosinusKeyword)
    for (let i = 0; i < search_result.length; i++) {
        docs[search_result[i].index].factorSenSimKey = (docs[search_result[i].index].keywordsSenSim / maxKeySenSim)
        docs[search_result[i].index].keywordsVal = (search_result[i].similarityIndex + docs[search_result[i].index].keywordsCos) * 0.5 
    }

    search_result = tf_idf_ft.rankDocumentsByQuery(cosinusKeyword)
    for (let i = 0; i < search_result.length; i++) {
        docs[search_result[i].index].factorSenSimFT = (docs[search_result[i].index].fullTextSenSim / maxFtSenSim)
        docs[search_result[i].index].fullTextVal = (search_result[i].similarityIndex + docs[search_result[i].index].fullTextCos) * 0.5
    }

    // cosine similarity sfKeyword, handmade first
    if (sfKeyword.length > 0) { 
        // buat ngeboost value karena word sim sifatnya match bukan ==
        const maxAbsWordSim = wordSimilarity(docs, sfKeyword, 1)
        const maxKeyWordSim = wordSimilarity(docs, sfKeyword, 2)
        const maxFtWordSim = wordSimilarity(docs, sfKeyword, 3)

        // cosine similarity dengan sf
        cosineSimilarity(docs, sfKeyword, 1)
        cosineSimilarity(docs, sfKeyword, 2)
        cosineSimilarity(docs, sfKeyword, 3)
    
        // cosinus similarity npm dengan sf
        // kemudian ditambah 0.2 * word sim value
        search_result = tf_idf_abs.rankDocumentsByQuery(sfKeyword)
        for (let i = 0; i < search_result.length; i++) {
            docs[search_result[i].index].factorSFAbs = (search_result[i].similarityIndex + docs[search_result[i].index].abstractCos) * 0.5
            docs[search_result[i].index].factorSFAbs += (ALPHA * docs[search_result[i].index].factorSFAbs * (docs[search_result[i].index].abstractWordSim / maxAbsWordSim))
            if (docs[search_result[i].index].factorSFAbs > 1) {
                docs[search_result[i].index].factorSFAbs = 1
            }
        }
    
        search_result = tf_idf_key.rankDocumentsByQuery(sfKeyword)
        for (let i = 0; i < search_result.length; i++) {
            docs[search_result[i].index].factorSFKey = (search_result[i].similarityIndex + docs[search_result[i].index].keywordsCos) * 0.5
            docs[search_result[i].index].factorSFKey += (ALPHA * docs[search_result[i].index].factorSFKey * (docs[search_result[i].index].keywordsWordSim / maxKeyWordSim))
            if (docs[search_result[i].index].factorSFKey > 1) {
                docs[search_result[i].index].factorSFKey = 1
            }
        }

        search_result = tf_idf_ft.rankDocumentsByQuery(sfKeyword)
        for (let i = 0; i < search_result.length; i++) {
            docs[search_result[i].index].factorSFFt = (search_result[i].similarityIndex + docs[search_result[i].index].fullTextCos) * 0.5
            docs[search_result[i].index].factorSFFt += (ALPHA * docs[search_result[i].index].factorSFFt * (docs[search_result[i].index].fullTextWordSim / maxFtWordSim))
            if (docs[search_result[i].index].factorSFFt > 1) {
                docs[search_result[i].index].factorSFFt = 1
            }
        }   
    }

    // cited count and reference count value, and factor 
    let maxFactorSenSim = 0
    let maxFactorSF = 0
    for (let i = 0; i < docs.length; i++) {
        docs[i].citedVal = parseInt(docs[i].cited_count) / maxCited 
        docs[i].referencesVal = docs[i].references_count / maxRef 

        if (crawlerOpt > 0) {
            docs[i].factorSenSim = (docs[i].factorSenSimAbs
                                    + docs[i].factorSenSimKey 
                                    + docs[i].factorSenSimFT) * 1.0 / 3.0
    
            docs[i].factorSF = 0
            if (sfKeyword.length > 0) {
                docs[i].factorSF = (docs[i].factorSFAbs
                                    + docs[i].factorSFKey 
                                    + docs[i].factorSFFt) * 1.0 / 3.0
            }
        } else {
            docs[i].factorSenSim = (docs[i].factorSenSimAbs + docs[i].factorSenSimKey) * 1.0 / 2.0
    
            docs[i].factorSF = 0
            if (sfKeyword.length > 0) {
                docs[i].factorSF = (docs[i].factorSFAbs + docs[i].factorSFKey) * 1.0 / 2.0
            }
        }

        // mencari max factor sensim dan sf untuk normalisasi
        if(docs[i].factorSenSim > maxFactorSenSim){
            maxFactorSenSim = docs[i].factorSenSim
        }
        if(docs[i].factorSF > maxFactorSF){
            maxFactorSF = docs[i].factorSF
        }

        docs[i].factor = (docs[i].factorSenSim * 0.4) + (docs[i].factorSF * 0.6)
    }

    // penalty for journal that have diff factorSenSim with factorSF more than treshold
    for (let i = 0; i < docs.length; i++) {
        // jika diff melebihi treshold maka factor akan menjadi 1 - (diff - treshold) bagian dari factor awal nya saja
        if(Math.abs((docs[i].factorSenSim / maxFactorSenSim) - (docs[i].factorSF / maxFactorSF)) >= PENALTY_TRESHOLD) {
            docs[i].factor *= (1 - (Math.abs((docs[i].factorSenSim / maxFactorSenSim) - (docs[i].factorSF / maxFactorSF)) - PENALTY_TRESHOLD))
        }
    }

    // jadi untuk abtractVal, keywordsVal, dan FullTextVal 
    // semuanya melewati process cosine similarity handmade dengan keyword + sf
    // baru cosine similarity npm lagi dengan keyword + sf 
    // kemudian val = (npm + handmade) / 2 
    // kemudian dicari factor = factorSenSim (40%) + factorSF (60%)
    // factorSF berasal dari cosinesim dengan sf dan wordsim dengan sf
    // factorSF -> untuk mencegah journal yang tidak sesuai dengan background (search factor) pencarian user 
    // factorSenSim -> untuk mencegah journal yang tidak mengandung keyword secara literal (genetic algorithm bukan genetic human hair, best algorithm)
    // factor akan memengaruhi fitness value, semakin mendekati 1 (max) maka journal = semakin relevant
}

// query -> simpleKeyword, mode 1 = abstract, 2 = keywords, 3 = fulltext
function sentenceSimilarity (docs, query, mode) { 
    // build newQuery for regExp creation
    let newQuery = query.charAt(0)
    for (let i = 1; i < query.length; i++) {
        if(query.charAt(i) === ' ') {
            newQuery += '\\s'
        } else {
            newQuery += query.charAt(i)
        }
    }
    newQuery = new RegExp(newQuery, 'gi')

    let max = 1
    for (let i = 0; i < docs.length; i++) {
        if (mode === 1) {
            docs[i].abstractSenSim = docs[i].abstract.match(newQuery)
            if (docs[i].abstractSenSim) {
                docs[i].abstractSenSim = docs[i].abstractSenSim.length + 1
                if(docs[i].abstractSenSim > max) {
                    max = docs[i].abstractSenSim
                }
            } else {
                docs[i].abstractSenSim = 1
            }
        } else if (mode === 2) {
            docs[i].keywordsSenSim = docs[i].keywords.match(newQuery)
            if (docs[i].keywordsSenSim) {
                docs[i].keywordsSenSim = docs[i].keywordsSenSim.length + 1
                if(docs[i].keywordsSenSim > max) {
                    max = docs[i].keywordsSenSim
                }
            } else {
                docs[i].keywordsSenSim = 1
            }
        } else {
            docs[i].fullTextSenSim = docs[i].full_text.match(newQuery)
            if (docs[i].fullTextSenSim) {
                docs[i].fullTextSenSim = docs[i].fullTextSenSim.length + 1
                if(docs[i].fullTextSenSim > max) {
                    max = docs[i].fullTextSenSim
                }
            } else {
                docs[i].fullTextSenSim = 1
            }
        }
    }

    return max
}

// query -> sfKeyword, mode 1 = abstract, 2 = keywords, 3 = fulltext
function wordSimilarity (docs, query, mode) { 
    // build newQuery for regExp creation
    let words = query.split(' ')
    let newQuery = []
    for (let i = 0; i < words.length; i++) {
        newQuery.push(new RegExp(words[i], 'gi'))
    }

    let max = newQuery.length
    for (let i = 0; i < docs.length; i++) {
        if (mode === 1) {
            docs[i].abstractWordSim = 0
        } else if (mode === 2) {
            docs[i].keywordsWordSim = 0
        } else {
            docs[i].fullTextWordSim = 0
        }

        for (let j = 0; j < newQuery.length; j++) {
            if (mode === 1) {
                const temp = docs[i].abstract.match(newQuery[j])
                if (temp) {
                    docs[i].abstractWordSim += temp.length + 1
                } else {
                    docs[i].abstractWordSim++
                }

                if(docs[i].abstractWordSim > max) {
                    max = docs[i].abstractWordSim
                }
            } else if (mode === 2) {
                const temp = docs[i].keywords.match(newQuery[j])
                if (temp) {
                    docs[i].keywordsWordSim += temp.length + 1
                } else {
                    docs[i].keywordsWordSim++
                }

                if(docs[i].keywordsWordSim > max) {
                    max = docs[i].keywordsWordSim
                }
            } else {
                const temp = docs[i].full_text.match(newQuery[j])
                if (temp) {
                    docs[i].fullTextWordSim += temp.length + 1
                } else {
                    docs[i].fullTextWordSim++
                }
                
                if(docs[i].fullTextWordSim > max) {
                    max = docs[i].fullTextWordSim
                }
            }
        }
    }

    return max
}

// API Testing cosine similarity
router.post('/cosineSimilarity', async (req, res) => {
    if(req.body.query){
        // let docs = [
        //     {
        //         id: 0,
        //         abstract: "I want to start learning to charge something in life start in learning startasd g learnings"
        //     },
        //     {
        //         id: 1,
        //         abstract: "reading something about life no one else knows"
        //     },
        //     {
        //         id: 2,
        //         abstract: "Never stop learning"
        //     },
        // ]

        docs = [ 
            {// komodo mlipir
                "index": 2,
                "g_id": "n88yQJOlg3kJ",
                "title": "Improved Adaptive Komodo Mlipir Algorithm",
                "abstract": " in order to improve the global search performance of the komodo mlipir algorithm this paper proposed two adaptive komodo mlipir algorithms with variable fixed parameters ikma-1; ikma-2 among them ikma-1 adaptively controls the parthenogenesis radius of female komodo dragons to achieve more efficient conversion of global search and local search second ikma-2 introduces adaptive weighting factors to the “mlipir” movement formula of komodo dragons to improve the local search performance both ikma-1 and ikma-2 were tested on 23 benchmark functions in cec2013 and compared with the other seven optimization algorithms the wilcoxon rank-sum test and friedman rank test were used to compare the performance of different algorithms furthermore ikma-1 and ikma-2 are applied to two constrained engineering optimization problems to verify the engineering applicability of the improved algorithm the results show that both ikma-1 and ikma-2 have better convergence accuracy than the initial kma in terms of the benchmark function simulation results ikma-1 improves the performance by 1758% compared to kma; ikma-2 improves by 1099% both ikma-1 and ikma-2 achieve better results than other algorithms for engineering optimization problems and ikma-2 outperforms ikma-1",
            },
            {// komodo mlipir but not og
                "index": 3,
                "g_id": "dGa4XdHyuiMJ",
                "title": "Komodo Mlipir Algorithm",
                "abstract": "this paper proposes komodo mlipir algorithm kma as a new metaheuristic optimizer it is inspired by two phenomena the behavior of komodo dragons living in the east nusa tenggara indonesia and the javanese gait named mlipir adopted the foraging and reproduction of komodo dragons the population of a few komodo individuals candidate solutions in kma are split into three groups based on their qualities big males female and small males first the high-quality big males do a novel movement called high-exploitation low-exploration to produce better solutions next the middle-quality female generates a better solution by either mating the highest-quality big male exploitation or doing parthenogenesis exploration finally the low-quality small males diversify candidate solutions using a novel movement called mlipir a javanese term defined as a walk on the side of the road to reach a particular destination safely which is implemented by following the big males in a part of their dimensions a self-adaptation of the population is also proposed to control the exploitation–exploration balance an examination using the well-documented twenty-three benchmark functions shows that kma outperforms the recent metaheuristic algorithms besides it provides high scalability to optimize thousand-dimensional functions the source code of kma is publicly available at https//suyantostafftelkomuniversityacid/komodo-mlipir-algorithm and https//wwwmathworkscom/matlabcentral/fileexchange/102514-komodo-mlipir-algorithm",
            },
            {// komodo mlipir irelevant
                "index": 4,
                "g_id": "-kzxhgJKQu8J",
                "title": "Circle Search Algorithm: A Geometry-Based Metaheuristic Optimization Algorithm",
                "abstract": " this paper presents a novel metaheuristic optimization algorithm inspired by the geometrical features of circles called the circle search algorithm csa the circle is the most well-known geometric object with various features including diameter center perimeter and tangent lines the ratio between the radius and the tangent line segment is the orthogonal function of the angle opposite to the orthogonal radius this angle plays an important role in the exploration and exploitation behavior of the csa to evaluate the robustness of the csa in comparison to other algorithms many independent experiments employing 23 famous functions and 3 real engineering problems were carried out the statistical results revealed that the csa succeeded in achieving the minimum fitness values for 21 out of the tested 23 functions and the p-value was less than 005 the results evidence that the csa converged to the minimum results faster than the comparative algorithms furthermore high-dimensional functions were used to assess the csa’s robustness with statistical results revealing that the csa is robust to high-dimensional problems as a result the proposed csa is a promising algorithm that can be used to easily handle a wide range of optimization problems view full-text ",
            },
            { // komodo mlipir irelevant
                "index": 5,
                "g_id": "EzmLDYVJtPAJ",
                "title": "Nature-Inspired Metaheuristic Search Algorithms for Optimizing Benchmark Problems: Inclined Planes System Optimization to State-of-the-Art Methods",
                "abstract": "in the literature different types of inclined planes system optimization ipo algorithms have been proposed and evaluated in various applications due to the large number of variants and applications this work provides an overview of ipo’s state-of-the-art in terms of variants presented applications statistical evaluation and analysis in addition the performance of ipo variants are evaluated and compared the results are benchmarked against other algorithms final evaluation based on statistical analysis and a new and effective ranking methodology indicates the optimal performance and relative success of all ipo variants and their performance in comparison with other recent diverse metaheuristic search competitors including reinforcement learning evolution-based swarm-based physics-based and human-based the performance of ipo variants shown that the use of bio-operators to improve the standard version is more successful than other applied approaches so that the successful performance of sipo + m with a minimum overall ranking of 073 has been ahead of all versions and the complexity of ipo equations has also been led to a high time loss and achieving a maximum overall ranking of 207 among other algorithms it shown that versions without control parameters perform exploration and exploitation processes intelligently and more successful for example poa-i poa-ii sloa opa and cmbo are among the methods that achieved the best performance with minimum overall ranking values of 0363 0384 0387 0424 and 0933 respectively",
            },
            { // genetic algorithm tapi bagian biologi, algorithm untuk genetic similarity
                "index": 1,
                "g_id": "EzmLDYVJtPAJ",
                "abstract": `IntroductionThe discussion about the relevance of “nature versus nurture,” or, in a similar manner, of “genotype versus phenotype,” in human biology and medicine is a long-standing issue that still remains largely unsolved. Relevant studies in this area include our original observation that monozygotic twins show epigenetic differences (Fraga et al., 2005), understood as the chemical marks such as DNA methylation and histone modifications that regulate gene expression, that might explain different population traits and distinct penetrance of diseases in these people, a finding supported in later studies (Kaminsky et al., 2009), including The NASA Twins Study (Garrett-Bakelman et al., 2019). These questions can be more easily addressed in experimental models where the researcher can intervene, such as the Agouti mice (Wolff et al., 1998) and cloned animals (Rideout et al., 2001), whereas in humans, the investigator has a more passive role, waiting for the right sample to appear. In this regard, one of the most documented cases is the Dutch famine at the end of WWII that was associated with less DNA methylation of the imprinted IGF2 gene compared with their unexposed, same-sex siblings (Heijmans et al., 2008).Human individual identity also relates to biological properties and environment. In this regard, the way we initially recognize each other relies often on our unique face, and there is a sophisticated brain code to distinguish facial identities (Tsao et al., 2006; Chang and Tsao, 2017; Quian Quiroga, 2017). This explains why so commonly twins catch our attention and are used to understand how the balance between nature and nurture generates a phenotype. Here, we present a study that, on a molecular level, aims to characterize random human beings that objectively share facial features. This extraordinary set of individuals, characterized by their high likeliness, are what are called, in lay-language, look-alike humans, unknown twins, twin strangers, doubles, or doppelgänger, in German. This unique set of samples has allowed us to study how genomics, epigenomics, and microbiomics can contribute to human resemblance. Our study provides a rare insight into human likeness by showing that people with extreme look-alike faces share common genotypes, whereas they are discordant at their epigenome and microbiome. Genomics clusters them together, and the rest set them apart. These findings do not only provide clues about the genetic setting associated with our facial aspect, and probably other traits of our body and personality, but also highlight how much of what we are, and what defines us, is really inherited or instead is acquired during our lifetime.ResultsFacial recognition algorithms and multiomics approaches for look-alike humansHuman doubles were recruited from the photographic work of François Brunelle, a Canadian artist who has been obtaining worldwide pictures of look-alikes since 1999 (http://www.francoisbrunelle.com/webn/e-project.html). We obtained headshot pictures of thirty-two candidate look-alike couples. All participants completed a comprehensive biometric and lifestyle questionnaire in their native language (English, Spanish, and French) (Methods S1). Their geographic locations are shown in Figure 1A. We first determined an objective measure of “likeness” for the candidate double pairs. We used three different methods of facial recognition: the custom deep convolutional neural network Custom-Net, (www.hertasecurity.com), the MatConvNet algorithm (Vedaldi and Lenc 2015), and the Microsoft Oxford Project face API (https://azure.microsoft.com/es-es/services/cognitive-services/face/) (STAR Methods). We used three methods because each system can yield variable results, and we selected those systems to reflect the diversity of possible outcomes. MatConvNet was designed for facial classification, Custom-Net for surveillance, and Microsoft API for generalized facial analysis. These models have millions of learned parameters and have been trained with millions of facial images from thousands of subjects, in a variety of unconstrained situations: differences in pose, hairstyle, expression, age, and accessories within a subject. Thus, the impact of these attributes is likely minimal. Each software provides a facial similarity score between 0 and 1, where 1 is the same facial image and 0 is two different entities. Comparisons are pairwise, with every image compared with every other image. As an example of the parameters computed, the 27 face landmarks of the Microsoft algorithm are shown in Figure 1B. The results obtained from the different combinations of each approach are shown in a Venn diagram in Figure 1C. Interestingly, the number of pairs that were considered to be correlated by at least two of the facial models was very high (25 out of total 32, >75%), closer to the human ability to recognize identical twins (Biswas et al., 2011). Most importantly, we found that 16 of the original 32 (50%) look-alike pairs were matched by all three facial recognition systems. As an internal positive control for high similarity score, we ran the three facial recognition software in monozygotic twin photograph images from the University of Notre Dame twins database 2009/2010 (https://cvrl.nd.edu/projects/data/). Importantly, similarity scores from the 16 look-alike couples were similar to those obtained from monozygotic twins according to MatConvNet and significantly higher than those observed in random non-look-alike pairs (Figure 1D). Thus, these highly look-alike humans were the focus of our further research. Illustrative examples of these “double” individuals are shown in Figure 1E.Download : Download high-res image (1013KB)Download : Download full-size imageFigure 1. Recruitment and objective determination of look-alike human pairs(A) Representation of the global worldwide distribution of 32 look-alike pairs (n = 64) in this study.(B) 27 facial parameters by which the Microsoft Oxford Project face API (Microsoft) objectively performs face detection.(C) Venn diagram showing the number of look-alike pairs discerned and jointly identified in the three facial recognition programs: MatConvNet, Custom-Net, and Microsoft. Numbers within the semi-circle present the pairs that did not cluster in each software.(D) Boxplots showing unbiased quantitative similarity scores comparing each facial recognition software (MatConvNet, Custom-Net, Microsoft) for monozygotic twins (MZs; blue), look-alike pairs (LALs; rose), and random non-LALs (red). The x axis represents the different cohorts analyzed. The y axis exhibits similarity scores measured between 0 and 1. 1 represents identical facial image, and 0 represents two totally different photographic entities. “N” indicates the number of couples. Differences calculated using two-sided Mann-Whitney-Wilcoxon test: ∗∗∗∗p < 0.0001; ∗∗∗p < 0.001; ns, non-significant.(E) Photographic examples of LALs used in this study.Saliva DNA for these cases was analyzed by multiomics at three levels of biological information: genome, by means of an SNP microarray that interrogates 4,327,108 genetic variants selected from the International HapMap and 1,000 Genomes Projects, which target genetic variation down to 1% minor allele frequency (MAF) (Xing et al., 2016); epigenome, using a DNA methylation microarray that studies over 850,000 CpG sites (Moran et al., 2016); and microbiome, by ribosomal RNA direct sequencing (Klindworth et al., 2013) (Figure 2A; STAR Methods).Download : Download high-res image (1MB)Download : Download full-size imageFigure 2. Genetic analysis of look-alike human pairs(A) Saliva DNA was obtained from 32 LALs recruited to this study. DNA was subjected to genotyping (Omni5-4 SNP arrays Illumina), DNA methylation (Infinium MethylationEPIC arrays, Illumina), and microbiome analysis (16S Metagenomics sequencing, Illumina).(B) Heatmap of hierarchical genetic clustering with bootstrap of genome-wide SNP genotyping arrays in the 16 LALs. Genotype clustering was performed using Euclidean distances and Ward.D2 cluster method. Blue rectangles represent 9 LALs that unbiasedly clustered. 0 = homozygous reference SNPs (green), 1 = heterozygous SNPs (black), and 2 = homozygous alternate SNPs (red).(C) Boxplot showing Kinship scores between MZs, LALs, and random non-LALs. Kinship scores range between −0.2 (it represents two unrelated individuals) and 0.5 (it represents duplicated genotypes and MZs). “N” indicates the number of couples. Differences calculated using two-sided Student's t test: ∗∗∗∗p < 0.0001; ∗∗p < 0.01.(D) Gene Ontology (GO) analysis performed using all SNPs found to be shared in all LALs (19,277 SNPs in 3,730 genes). GO enrichments were ran using EnrichGO R package for the 3,730 genes, and the top 10 most significant hits are plotted in network graphs. GO terms are presented with circles. The size and color of each circle represents numbers of genes in each GO term and its statistical significance, respectively. The gray lines represent the interaction of genes, and the thickness is proportional to the number of genes interacting in each GO term. GO subcategories are presented: Biological Process, Cellular Component, and Molecular Function.Genomic characterization of look-alike humansGenomic analyses of these 16 couples provided a striking result: more than half (9 of 16, 56.2%) of these look-alike pairs clustered together in the unsupervised clustering heatmap with bootstrap (Figure 2B). These nine couples were denominated as “ultra” look-alike. K-means algorithm represented by principal-component analysis (PCA) and t-distributed stochastic neighbor embedding (t-SNE) also showed that the look-alike couples that clustered by the unsupervised clustering heatmap analysis were in close proximity (Figure S1), indicating a likely genotyping resemblance of the studied pairs. In contrast, the 16 candidate look-alike cases that did not cluster by the three facial recognition (FR) networks (Figure 1C) showed that only one pair clustered together (1 of 16, 6.2%) (Figure S1).We studied two possible confounding factors: population stratification (ancestry) and kinship. Using KING Relationship Inference (Manichaikul et al., 2010) to determine kinship scores, we discarded the possibility of unknown familial relationships (first and second degree) between look-alike pairs (Figure 2C). We observed that look-alike pairs were more similar to non-look-alike pairs than to monozygotic twins (Figure 2C); supporting that look-alike pairing in the SNP clustering is not related to familyhood genotype but instead to a distinct subset of genetic similarity. Using PLINK (Purcell et al., 2007) (STAR Methods), close kinship could be excluded in almost all cases: only one pair share SNPs in proportions that could be compatible with up to third-degree relatives and only one pair share a long (>10 cM) identity by descent (IBD) segment that could suggest co-ancestry in the last few hundreds of years. Interestingly, the latter is a French-Canadian pair, a population known to have experienced a dramatic founder effect in the 17th century. Importantly, when we conducted all the downstream analyses without this French-Canadian pair, the remaining eight ultra-look-alike pairs clustered together (Figure S2). The detailed kinship assessment data are provided in Table S1.Related to population stratification, among the 16 look-alike pairs, 13 were of European ancestry, 1 Hispanic, 1 East Asian, and 1 Central-South Asian. Although background genetic ancestry is a principal determinant for genetic variance between human populations, we observed that of the 13 White look-alike pairs, 7 (54%) did not cluster genetically, suggesting alternative purposes for shared genetic variation between look-alike pairs. To further determine ancestry, genotyping of the 16 look-alike cases was performed using GenomeStudio v.2.0.5 to create PACKPED Plink files (STAR Methods). Their genomic data were merged with 1,980 West Eurasian, Asian, and Native American individuals genotyped in the Affymetrix Human Origins (HO) array (Lazaridis et al., 2014), where the remaining dataset held 175,469 common SNPs. PCA was generated with the HO individuals (Figure S3) and look-alike individuals (Figure S3B for West Eurasia and Figure S3C for West Eurasia, Asia, and America) (Price et al., 2006; Patterson et al., 2006) (STAR Methods). We observed that almost all the look-alike pairs cluster close to each other according to their countries of origin (or self-attributed ethnic background) (Figure S3). However, they are not more closely related than other pairs of individuals from the same populations taken at random. The detailed population stratification data are provided in Table S1.Among the 9 couples of ultra-look-alikes, 19,277 SNP positions annotated for 3,730 genes (Table S2) were defined as SNPs with shared genotypes in each look-alike pair. These SNPs correspond to non-monomorphic positions in which every pair of ultra-look-alikes shared the genotype. For example, where one individual in a pair was heterozygous for a given SNP, the corresponding individual in the pair was also heterozygous. This genotype match must be consistent across all pairs for an SNP to be considered shared and therefore represented indicative SNPs relevant for look-alike resemblance. The number of shared SNP positions was significantly higher compared with random non-look-alike pairs in the studied population (p < 2.2 × 10−16, Pearson’s chi-squared test). Taking into account ethnicity, shared SNP positions by the European ultra-look-alike pairs was significantly higher compared with random non-look-alike pairs in the studied population (p = 0.03, Pearson’s chi-squared test). For the remaining three ethnicities, only one individual from each group was available in our dataset. Thus, we interrogated the individuals genotyped in the 1000 Genomes database (https://www.internationalgenome.org/). The number of shared SNP positions by the Hispanic ultra-look-alike pair was significantly higher compared with random individual pairs from the same ethnicity (p < 2.2 × 10−16, Pearson’s chi-squared test). No significant enrichment was observed for the remaining two couples, one East Asian and one Central-South Asian. Importantly, only 16 variants of the 19,277 SNPs (0.08%) selected from the ultra-look-alikes presented a linkage disequilibrium detected by iterative pruning analysis (Weir et al., 2014).The identified genetic variants might have a profound impact on the degree of similitude between the phenotype of humans. Using the clusterProfiler R package (Yu et al., 2012), we performed gene enrichment analyses using the list of look-alike SNPs compared with the background of all genes annotated in the SNP microarray. We observed an enrichment for Gene Ontology (GO) Biological Processes related to anatomical, developmental, and adhesion terms (Figure 2D; Table S3), in addition to ion and anion binding for GO-Molecular function (gene subsets related to bone and skin properties) and many cellular compartments. Enrichment analysis using the DAVID signature database collection noted that the most significantly enhanced ontology was “cell junction,” a critical determinant of tissue morphology (Table S4). To evaluate the face genes enrichment in our selected 19,277 SNPs corresponding to 3,730 genes (Table S2), we gather all the genes related with face traits from recent data (Claes et al., 2018; Xiong et al., 2019; White et al., 2021), Facebase dataset (https://www.facebase.org/), and Genome-wide Association Study (GWAS) Central (study HGVST1841, http://www.gwascentral.org) and applied a hypergeometric test and a Monte Carlo simulation using 10,000 iterations (STAR Methods). In no iteration of random set of genes did we observe a number equal to or higher than the face genes represented in our 19,277 SNP selection (p < 1e−4). We observed a total of 1,794 face genes in our 19,277 SNP selection, constituting 26% of all the face genes present in the array (hypergeometric test p: 6.31e−172; Monte Carlo empirical p < 1e−4). When we added the reported face associated SNPs to our 19,277 SNPs, we observed that 11 of the 16 (68.7%) look-alike pairs clustered together (Figure S4), therefore adding two new couples.The study of the functional nature of the SNPs loci shared by the ultra-look-alikes showed that 171 caused amino acid changes, affecting 158 genes (Table S5). GOrilla analysis for GO-Molecular function found an enrichment in anion transport descriptors (Table S3). Using the GWAS catalog database (https://www.ebi.ac.uk/gwas/), we found that 113 SNPs corresponded to 130 GWAS associations and 84 traits (Table S6). These last traits included many related to facial determinants or physical features such as cleft palate/lip, eye color, hip circumference, body height, waist-hip ratio, balding measurement, and alopecia (Table S6) with an enrichment for lip and forehead morphology, body mass index, bone mineral density, and attached earlobe (Table S6). We observed an enrichment of traits that included the word morphologytagged to the terms nose, lip, mouth, facial, cranial vault, forehead, hair, and cheekbone (Fisher’s exact test, odds ratio [OR] = 4.2, p = 0.04). Using the GWAS Central database (http://www.gwascentral.org), we found an enrichment (OR = 1.2782, p = 0.0007364) for SNPs associated with human facial variation (Adhikari et al., 2016). The analyses of the look-alike SNPs according to trait in GWAS Central showed an enrichment for the phenotype names “lip” (OR = 1.8321, p = 0.000327) and “forehead” (OR = 1.886, p = 0.010389). The identified look-alike SNPs were also enriched (OR = 2.201156, p = 0.04884) for genes included in the FaceBase dataset (https://www.facebase.org/). Finally, we studied the overlap between the herein discovered look-alike SNPs and expression quantitative trait loci (eQTLs). Using the Genotype-Tissue Expression (GTEx) Portal (https://www.gtexportal.org/home/), we observed that look-alike SNPs were more frequently associated with gene-expression changes than expected by random chance (Fisher’s exact test, OR = 1.1, p = 0.0001). The enrichment was observed among different morphological structures and organs (Table S6). We also used the stratified linkage disequilibrium score regression (S-LDSC) (Finucane et al., 2015) to determine the enrichment of GWAS signals from the GWAS catalog for our SNPs. We observed that these SNPs were overrepresented for the pronasale-right chelion (enrichment score [ES] = 13.84, p = 0.018) and pronasale-left chelion (ES = 12.26, p = 0.04) face traits (Figure S4) (Xiong et al., 2019). The SNPs were also overrepresented for features that define 63 facial segments (Hoskens et al., 2021) considering the entire, mid, and outer face (p < 0.05) (Figure S4). These data indicate that the 19,277 characterized SNPs exert a major impact in the way the face of humans is defined.The SNP microarray can also be used to determine copy-number variations (CNVs) (Feber et al., 2014). Unsupervised clustering heatmap with bootstrap clustered only one couple together of the 16 look-alikes according to CNVs (Figure 3A). Interestingly, three CNVs were shared by three look-alike pairs (Table S6), including a locus in chromosome 11 that targets genes involved in craniofacial dysmorphic features such as HYLS1 (Mee et al., 2005).Download : Download high-res image (989KB)Download : Download full-size imageFigure 3. Copy-number variation, DNA methylation, and microbiome analysis of LALs(A) Heatmap shows the hierarchical clustering of the samples based on the copy number (scale of 0–4) of all copy-number variation (CNV) regions, defined as regions in which at least one individual carried a different copy number. A random selection of one-fifth of such CNV regions is represented in this plot, but the clustering of samples had been obtained considering all CNV regions. The blue rectangle represents a LAL that clusters together.(B) Heatmap shows unsupervised genome-wide DNA methylation hierarchical clustering with bootstrap of the 16 LALs, using the methylation β-values obtained from MethylationEPIC arrays. A random selection of 5000 CpGs is represented. Colors represent a continuous quantification of methylation beta values at each CpG site, where green highlights unmethylated CpGs (0), black, 50% methylated CpGs (0.5), and red, fully methylated CpGs (1). Clustered look-alikes are shown in a blue rectangle.(C and D) Microbiome analysis of 16 LALs. Heatmaps show the distances from differences in pairwise bacterial counts of species found in the microbiome of each LAL (variation in alpha diversity scores) of counts from 0–55 (3C) and relative proportions of the taxonomic profiles at the genus level (3D) for each sample calculated on a scale of 0–0.5. Only the most represented genera are shown. Meta-genomic clustering of each look-alike sample was constructed using Euclidean distances and Ward.D2 hierarchical cluster method. Blue rectangle represents LALs whose microbiome is closely related.Other multiomics views of look-alike humansSimilar “identities” of look-alikes could also reside in other “omic” components such as the DNA methylome and the microbiome. According to DNA methylation patterns, only one of the sixteen (6.25%) look-alike pairs matched both individuals together, as shown in the unsupervised clustering heatmap (Figure 3B). This couple also clustered together according to SNP genotyping (Figure 2B). The comparison of DNA methylation patterns among the nine look-alike couples with the observed genetic overlap (Figure 2B) only clustered one additional pair (Figure S4). K-means algorithm represented using PCA and the t-SNE plot did not show significant clustering (Figure S5). Thus, overall, human look-alikes are diverse in their epigenome settings.However, two avenues might provide a role for DNA methylation in facial morphology: epigenetic age and methylation QTL (meQTLs). The aging process changes facial morphology, and DNA methylation is used as a proxy for “biological age” that can or can not be directly related to the “chronological age.” One example is the premature epigenetic aging observed in carriers of viral infections (Esteban-Cantos et al., 2021; Cao et al., 2022). We have calculated the intrapair absolute age differences in our 16 look-alike cohort according to chronological age (date of birth) or epigenetic age (DNA methylation clock) (Hannum et al., 2013). We found no differences in intrapair chronological age between the ultra-look-alike group and the non-ultra-look-alike group. In contrast, intrapair “epigenetic” age differences were smaller among ultra-look-alike pairs compared with the non-ultra-look-alike group (two-sided Mann-Whitney-Wilcoxon test, p = 0.0052) (Figure S6). DNA methylation is also associated with genetic variation (Villicaña and Bell, 2021) and could contribute to individual similarity acting as meQTLs. Using the methylation status of 1,379 CpG sites located within a window of +100 bp from the identified 19,277 SNPs, we observed that 3 of the 16 (18.7%) look-alike pairs clustered together (Figure S6). All three of these pairs were among the 9 ultra-look-alike couples (Figure 2B). Thus, DNA methylation, as a marker of biological age and meQTL, can also provide phenotypic commonality for ultra-look-alikes.A similar scenario was found for the microbiome. From a qualitative standpoint (alpha diversity), according to the type of bacteria present in the studied oral sample (STAR Methods), only one look-alike pair clustered together (Figure 3C). This couple did not cluster together according to SNP genotyping (Figure 2B). From a quantitative standpoint, according to the amount of each bacteria strand present (STAR Methods), we found clustering of one look-alike pair (6.25%, 1 of 16) (Figure 3D). This couple also paired together by unsupervised SNP clustering (Figure 2B). The study of the nine couples with SNP similarity did not provide further pairing of look-alikes (Figure S6). K-means algorithm illustrated by PCA and t-SNE did not demonstrate clustering (Figure S7). Thus, look-alikes do not mostly share a microbiome. However, oral microbiome relates to obesity (Yang et al., 2019), and fat in the face could relate to similarities. We found that intrapair weight differences were smaller among ultra-look-alike pairs compared with non-ultra-look-alike pairs (two-sided Student’s t test test, p = 0.035) (Figure S7). Thus, it is possible that the oral microbiome, through its relation to fat content, contributes to look-alike phenotypes.Traits of look-alike humans beyond facial featuresThe likeness between the identified human pairs is not limited to the shared facial traits. All the recruited participants in the study completed a comprehensive biometric and lifestyle questionnaire (Methods S1), and the collected information is summarized in Figure 4A. Overall, 68 parameters (Table S7) were included and converted to numerical or logical (0/1) variables (STAR Methods, (custom scripts GitHub: https://github.com/mesteller-bioinfolab/lookalike). The input curated questionnaire is shown in Table S7. We used a cosine similarity method (STAR Methods) to calculate likeness between the studied individuals according to the questionnaire answers. Studying the original 32 look-alike couples, we observed that the 16 look-alike pairs that matched together by all three facial recognition software showed shorter Euclidean distances within pairs (p = 0.03475) and higher cosine similarity scores (p = 0.00321) than those pairs that did not match by the facial algorithms (Figure 4B). According to their SNPs, the 16 look-alike pairs showed shorter Euclidean distances compared with those pairs that did not match by the three facial algorithms (p = 0.00006) (Figure 4B). Examples of independent questionnaire variables (such as height, weight, smoking habit, or level of education) further demonstrate that look-alike pairs are closer than non-look-alike pairs (Figure 4C). Thus, humans with a similar face might also share a more comprehensive physical, and probably behavioral, phenotype that relates to their shared genetic variants. Our study supports the concept of heritability estimation that individuals correlated at the phenotype level share a significant number of genotypic correlations (Visscher et al., 2008). Our results are germane to the ongoing efforts to predict biometric traits from genomic data (Lippert et al., 2017) and the diagnosis of genetic disorders using facial analysis technologies (Gripp et al., 2016; Hadj-Rabia et al., 2017; Hsieh et al., 2019; Gurovich et al., 2019).Download : Download high-res image (594KB)Download : Download full-size imageFigure 4. Biometric and lifestyle analysis of LALs using cosine similarity scores(A) Representation of the biometric and lifestyle parameters considered to calculate cosine similarity scores.(B) Euclidean distances between the individuals from a pair (intra-pair distance) compared with the distance between individuals from different pairs (extra-pair distance). Distances were calculated for questionnaire (top) and SNP data (below). Statistics by Student’s t test.(C) Distance boxplots for independent questionnaire variables generated by calculating, for all possible pairs of samples, their absolute differences for each variable. We then classified all pairs between pairs of look-alikes and pairs of non-look-alikes. Statistics by Wilcoxon rank sum tests.DiscussionOur study deciphers molecular components associated with facial construction by applying a multiomics approach in a unique cohort of look-alike humans that are genetically unrelated. Saliva DNA was subjected to genome-wide analyses of common genetic variation, DNA methylation, and microbiome analysis. We also performed a biometric and lifestyle analysis for all look-alike pairs. We found that 16 of the 32 look-alike pairs clustered in all three facial recognition software. Genetic analysis revealed that 9 of these 16 look-alike pairs (Figure 2B) clustered, identifying 19,277 common SNPs. Furthermore, analyses of these shared variants in GWAS and GTEx databases revealed enrichment for phenotypes related to body and face structures and an association with gene-expression changes. Together, this suggests that shared genetic variation in humans that look alike likely contribute to the common phenotype.Historically, research into face morphology was heavily centered on craniofacial anomalies (Richmond et al., 2018). However, there is a recent growing interest into normal-range face variation, attributable to the necessity for facial recognition software for everyday life (smartphones, CCTV cameras, etc.). Easy access to low-cost, high-resolution pictures and advances in genotyping technology has ignited an age-old question: what makes humans look as they do? Association studies revealed low-frequency genetic variants with relatively small penetrance in facial features, suggesting a far more complex genetic role. Non-genetic factors can affect the expression of genes that form the face. Many epigenetic or imprinting disorders present craniofacial anomalies, such as patients with Prader-Willi or Angelman syndrome (Girardot et al., 2013), and microbial disruption is associated with developmental defects (Robertson et al., 2019). Despite evidence for epigenetic variation in human populations (Heyn et al., 2013) and development (Garg et al., 2018), only one look-alike pair clustered by DNA methylation. This pair also clustered together by SNPs, suggesting that the shared epigenetic profile is likely due to their underlining shared genetics (Lienert et al., 2011), as it was also supported by analyzing CpGs in the vicinity of the SNPs. In addition, ultra-look-alike pairs showed similar epigeneticages. Similarly, only one look-alike pair clustered by microbiome analysis, but ultra-look-alike pairs displayed similar weights, and microbiome composition could relate to obesity (Yang et al., 2019). These findings support a modest role for these biological components to determine facial shape; however, more evidence is required to discard a greater impact.Finally, 68 biometric and lifestyle attributes from the look-alike pairs were studied. Physical traits such as weight and height as well as behavioral traits such as smoking and education were correlated in look-alike pairs, suggesting that shared genetic variation not only relates to shared physical appearance but may also influence common habits and behavior.Overall, we provided a unique insight into the molecular characteristics that potentially influence the construction of the human face. We suggest that these same determinants correlate with both physical and behavioral attributes that constitute human beings. These findings provide a molecular basis for future applications in various fields such as biomedicine, evolution, and forensics. Through collaborative efforts, the ultimate challenge would be to predict the human face structure based on the individual’s multiomics landscape.Limitations of the studyDue to the difficulty to obtain look-alike data and biomaterial, the sample size is small, restricting our ability to perform large-scale statistical analyses. Thus, some partially negative results, such as those derived from the non-genetic data, could relate to an underpowered study. The used headshots were two-dimensional, black and white images, and valuable information regarding three-dimensional constructs, subtle skin tones, and unique facial features are lacking. In addition, the used SNP array does not allow for the analysis of other genetic components such as structural variations and shared rare events. Another limitation is that our samples were mostly from European origin. Thus, the study could not effectively address the impact of the used multiomics in other human populations.STAR★MethodsKey resources tableREAGENT or RESOURCESOURCEIDENTIFIERCritical commercial assaysOragene DNA tubesDNA GenotexOG-500Pico Green fluorescence kitLife technologies/thermosP7589EZ DNA Methylation KitZymo ResearchD5003Deposited dataHumanOmni5-Quad BeadChipThis paperGEO: GSE142304Infinium MethylationEPIC BeadChipThis paperGEO: GSE14230416S metagenomics sequencingThis paperBioProject: PRJNA596439Custom scriptsThis paperhttps://github.com/mesteller-bioinfolab/lookalikeLook-alike photographswww.francoisbrunelle.com/webn/e-project.htmlhttps://github.com/mesteller-bioinfolab/lookalike/blob/master/FB_LAL_images.zipExperimental models: Organisms/strainsHumans (Homo sapiens)Look-alike individuals upon consent.N/ASoftware and algorithmsRR Core team., 2019www.r-project.org/MatConvNetVLFeathttp://www.vlfeat.org/matconvnetMicrosoft Oxford Project face APIMicrosoft Azurehttps://azure.microsoft.com/en-us/services/cognitive-services/face/Herta CNN algorithmHerta Securitywww.hertasecurity.comGenomeStudio (v2.0.4)Illuminahttps://support.illumina.com/downloads/genomestudio-2-0.htmlpvclustSuzuki and Shimodaira, 2006http://stat.sys.i.kyoto-u.ac.jp/prog/pvclust/hclustMüllner, 2013https://stat.ethz.ch/R-manual/R-devel/library/stats/html/hclust.htmlKinship-based INference for GWAS (KING v2.2.3)Manichaikul et al., 2010http://people.virginia.edu/∼wc9c/KING/Minfi (v1.32.0)Aryee et al., 2014Fortin et al., 2017https://bioconductor.org/packages/release/bioc/html/minfi.htmlclusterProfilerYu et al., 2012https://guangchuangyu.github.io/2016/01/go-analysis-using-clusterprofiler/Database for Annotation, Visualization and Integrated Discovery (DAVID v6.8)Huang et al., 2009https://david.ncifcrf.gov/GOrillaEden et al., 2007, Eden et al., 2009http://cbl-gorilla.cs.technion.ac.il/GTEx portal (v7)https://gtexportal.org/N/AGWAS catalogBuniello et al., 2019https://www.ebi.ac.uk/gwas/GWAS centralBeck et al., 2020https://www.gwascentral.org/MG-RASTKeegan et al., 2016https://www.mg-rast.org/Greengenes rRNA databaseMcDonald et al., 2012https://greengenes.secondgenome.com/OtherFrançois Brunelle websitewww.francoisbrunelle.com/webn/e-project.htmlN/AUniversity of Notre Dame twins database 2009/2010https://cvrl.nd.edu/projects/data/N/AResource availabilityLead contactFurther information and requests for reagents and resource may be directed to and will be fulfilled by the lead contact, Dr. Manel Esteller (mesteller@carrerasresearch.org).Materials availabilityThis study did not generate new unique reagents.Experimental model and subject detailsRecruitment of look-alikes32 Look-alike pairs (n = 64 individuals) that were initially recruited and photographed by François Brunelle (http://www.francoisbrunelle.com/webn/e-project.html) were enrolled to this study. All 64 individuals [42 females (65.6%) and 22 males (34.4%) with a median age of 40 years (range from 21 to 78 years), Table S7] were required to complete an extensive biometric and life-style questionnaire (Methods S1: Data collection questionnaire, related to STAR Methods) as well as provide legally signed consent forms approved by our bioethics committee for usage of both their facial images and DNA samples for this study. The study protocol was approved by the Clinical Research Ethics Committee of the Bellvitge University Hospital with the reference number PR348/16. To compliment this study, we were also provided with access to 100 monozygotic twin photos from the University of Notre Dame twins database 2009/2010 (https://cvrl.nd.edu/projects/data/). License agreements for data access were reviewed and signed by legal representatives of all entities involved in this study. 50 monozygotic twin pairs (n = 100) photographs were subsequently downloaded and analysed with the facial recognition algorithms detailed below.Method detailsFacial recognition algorithmsThree facial recognition algorithms were used to objectively analyze look-alike pairs: MatConvNet CNN algorithm, provided by the University of Pompeu i Fabra, Barcelona (Vedaldi and Lenc 2015); Microsoft Oxford Project face API by Microsoft; and the custom deep convolutional neural network Custom-Net (www.hertasecurity.com). The quantitative assessment of pairwise similarity between face photographs was calculated as follows. For the MatConvNet algorithm, the face biometric template from each photo was extracted from each processed face by means of a deep convolutional neural network (CNN) built into MatConvNet software. The resulting templates are represented as integer sparse descriptors of 8,192 values, which effectively encode the identity features of a face image (Vedaldi and Lenc 2015). Final pairwise similarity scores were set on a scale of 0–1 where 1 represents identical faces.The custom deep convolutional neural network Custom-Net was developed by a leader in facial recognition platforms (www.hertasecurity.com). Firstly, a generic face detector optimized for unconstrained video surveillance scenarios was used to obtain the locations of all faces in each image (Zhang and Zhang, 2010). The threshold was adjusted to find all targeted faces in each photo, and a subsequent manual exploration was conducted to ensure that no false positives were included. Each face was cropped with a 25% extra margin from the original bounding box, converted to grayscale and resized to 250 × 250 pixels. Next, a face biometric template was extracted from each processed face by means of a deep convolutional neural network of 32 layers. The resulting templates were represented as integer sparse descriptors of 4,096 values, which effectively encode the identity features of a face image. Finally, the similarity score between a pair of images was computed as a negative mean square deviation between their template values. The final scores were mapped to a range 0–1, where 1 indicated identical faces, according to landmarks taken from the histogram of imposter pairs extracted from the well-known database (http://vis-www.cs.umass.edu/lfw/).In the case of the custom deep convolutional neural network, the models have tens of millions of learned parameters and have been trained with more than 10 million facial images from over a hundred thousand subjects from different human populations, in a variety of unconstrained situations: differences of pose, expression, age and accessories within a subject. Moreover, the training process of a face recognition algorithm typically involves "data augmentation" operations, in which input images are randomly modified, e.g. by artificially synthesizing glasses, adding facial occlusions, mirroring faces, etc. in order to add intraclass variability to the images and confer robustness to the resulting model. As a consequence, modern face verification algorithms have recently achieved near-perfect accuracy, as high as 99.97% on NIST’s Facial Recognition Vendor Test (https://pages.nist.gov/frvt/html/frvt11.html#overview), for passport photo or mugshot scenarios, to the point that banks worldwide have widely adopted such systems for user verification. Particularly, these algorithms have become extremely reliable on controllable, almost ideal scenarios such as those captured by the photographer: 1:1 verification between large resolution images with good illumination, non-lateral poses (less than 60°) and without heavy occlusions; despite circumstancial similaritiy in interclass appearance like that given by glasses, facial expression or hairstyle. Thus, the impacts of these attributes, such as pose, hairstyle etc can be considered minimum, because the incorporated models have been exposed to these variations, in addition to additional features aspects such as colour styles, image degradations etc. The VGG dataset (https://www.robots.ox.ac.uk/∼vgg/data/vgg_face/) shows examples of facial data used to train Matconvnet (Parkhi et al., 2015) and CustomNet (http://vis-www.cs.umass.edu/lfw/).The Microsoft Oxford Project face API by Microsoft operates on a number of attributes that affect facial features such as age, gender, pose, smile, and facial hair along with 27 other landmarks for each face. These landmarks are left pupil, right pupil, nose tip, left mouth, right mouth, outer left eyebrow, inner left eyebrow, outer left eye, top left eye, bottom left eye, inner left eye, inner right eye, outer right eyebrow, inner right eye, top right eye, bottom right eye, outer right eye, left nose root, right nose root, top left nose alar, top right nose alar, left outer tip of nose alar, right outer tip of nose alar, top upper lip, bottom upper lip, top under lip and bottom under lip (https://azure.microsoft.com/en-us/services/cognitive-services/face/). The final similarity scores were also set on a scale of 0–1.Facial similarityPair-wise facial similarity matrices were provided as an output for all three facial recognition software. Similarity scores were assigned as numerical values ranging between 0 – 1 where 1 represents identical images and 0, two opposed images. To obtain objective look-alike pairs, we performed unsupervised hierarchical clustering with bootstrap using the pvclust (Suzuki and Shimodaira 2006) in R statistical environment (v3.6.1) (https://www.R-project.org/).Sample preparationGenomic DNA from look-alike pairs in this study were isolated from saliva and self-collected into Oragene 500 DNA tubes and extracted according to the manufacturers instructions (DNA genotek). >10% of the extracted DNA corresponded to microbial DNA. DNA was quantified using Pico Green fluorescence kit/Qubit® 2.0 Fluorometer (life technologies). Bisulfite modification of genomic DNA was carried out with the EZ DNA Methylation Kit (Zymo Research) following the manufacturer’s protocol.HumanOmni5-Quad BeadChipComprehensive cross-examination of genome-wide single nucleotide variation of 4.3 million SNVs across all Look-alike pairs was performed using HumanOmni5-Quad BeadChip (Illumina). 400 ng of genomic DNA was applied to HumanOmni5-Quad BeadChip and scanned using HiScan SQ system (Illumina). The signal raw intensities for each array were assessed and analyzed with GenomeStudio Software (v2.0.4) (Illumina) using default normalization to generate X and Y intensity values for A and B alleles (generic labels for two alternative SNP alleles), respectively. Genotype calling were performed by using GenomeStudio GenCall method and only genotypes with high GenCall scores (GC) were selected (according to Illumina standards). The positions corresponding to Illumina internal controls were also removed from the analysis. In order to remove the positions shared between look-alike pairs by chance, a bootstrap look-alike control analysis was performed. Briefly, we generated 100 datasets of 16 random pairs extracted from the initial 32 pairs (64 individuals) used in the study and the complete SNP set from the Omni5 array (4M SNPs). The only requirement was that none of the generated random pairs in the 100 datasets included a candidate look-alike pair from the initial 32 couples. We applied to each of these new 100 "non-look-alike" datasets the same SNP selection protocol used in the look-alike datasets, i.e. removing monomorphic and non-autosomal positions and selecting the shared inter-look-alike genotypes for each of the 16 pairs. This iterative process produced 100 independent SNP datasets that represented shared genotypes between non-look-alike pairs. Each of the SNP lists obtained contained an average of 5000 SNPs. The plot of the cumulative distribution of these shared SNPs after 100 iterations shows that the number of observed SNPs tends to plateau, indicating that we are reaching a maximum number of SNPs shared by the non-look-alike pairs is being reached. Next, we pooled all 100 SNP datasets into one table removing all redundant variants. This table of unique SNPs was considered as the SNP positions shared between pairs independent of their look-alike status (by chance) and were subsequently removed from our analysis of the look-alike pairs. Then the XY and monoallelic positions for the 16 original pairs were removed. Finally, the SNPs with identical genotypes in each of the 16 pairs and located in genes were selected for further analysis. CNV calling was performed by using PennCNV plugin in GenomeStudio with default parameters.Infinium MethylationEPIC BeadChipGenome-wide DNA methylation interrogation of >850,000 CpG sites was performed using the Infinium MethylationEPIC BeadChip (Illumina) according to manufacturer’s recommended protocol, as previously described (Moran et al., 2016). Briefly, 600 ng of DNA was used to hybridize to the EPIC BeadChip and scanned using HiScan SQ system (Illumina). Raw signal intensity data were initially QC’d and pre-processed from resulting idat files in R statistical environment (v3.6.1) using minfi Bioconductor package (v1.32.0). A number of quality control steps were applied to minimize errors and remove erratic probe signals. Firstly, interrogation of sex chromosomes was performed to identify potential labeling errors. Next, the removal of problematic probes was carried out, such as failed probes (detection p value > 0.01), cross-reacting probes and probes that overlapped single nucleotide variants within +/− 1bp of CpG sites followed by background correction and dye-based normalization using ssNoob algorithm (single-sample normal-exponential out-of-band). Lastly, we removed all sex chromosomes. Final DNA methylation scores for each CpG were represented as a β-values ranging between standard 0 and 1 where 1 represents fully methylated CpGs and 0, fully unmethylated. All downstream analyses were performed under R statistical environment (v3.6.1).16S meta-genomics sequencingWe identified and compared bacterial populations from diverse microbiomes from all look-alike pairs using 16S metagenomics sequencing (Illumina) (Klindworth et al., 2013). Salival DNA was extracted and bacterial libraries prepared following the Illumina 16S Library preparation protocol. The variable V3 and V4 regions of 16S rRNA was amplified in order to obtain a single amplicon of approximately 460 bp that underwent paired-end sequencing using MiSeqDx (Illumina). Resulting fastq files were analysed using MG-RAST. The counts corresponding to taxonomic abundance profiles for each sample were retrieved by using MG-RAST tools. Particularly, we retrieved the bacterial counts from sequences aligned to Genus taxonomic categories in the Greengenes rRNA database with the following cutoffs: an alignment length of 15 bp, a percent identity of 60% and an e-value equal or lower to 1 × 10−5. The relative proportions for each genus and sample were calculated and only the most represented genus were used.Quantification and statistical analysisPopulation-level vs shared SNPs in look-alike pairsIn order to define the number of SNPs shared between non look-alike pairs by chance we generated 55 random combinations of the 9 ultra look-alike pairs avoiding in each dataset the presence of a look-alike pair. We selected the SNP positions with the same genotype for each of the 9 non look-alike pairs in any of the 55 control datasets, obtaining the percent of randomly shared variants in a data set of 9 non look-alikes. Finally, we calculated the statistical significance of the comparison between SNPs shared in look-alike and non look-alike pairs by a Pearson’s chi-squared test (p value <2.2 10−16). However, since different pairs of look-alikes were from multiple different ethnicities, but individuals in the same look-alike pair shared the same ethnicity, we also performed the enrichment analysis to determine if the number of shared SNPs was more than expected by chance accounting to ethnicity. Thus, we tested pairs of European ancestry individuals with other Europeans and repeated the same for each of the different ethnicities. To this end, we downloaded the most recent set of Omni genotypes from 1000 Genomes available in the phase 3 release directory (ftp://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/supporting/hd_genotype_chip/). The downloaded 1000 Genomes phase 3 vcf file was transformed to Genomic Data Structure (GDS) format using the function seqVCF2GDS from SeqArray R package (version 1.36.0). Look-alike PLINK PED files were also transformed to GDS format using the fucntion snpgdsPED2GDS from SNPRelate R package (version 1.30.1). The 1000 Genomes genotyping data was merged with the “ultra” look-alikes genotyping data and the remaining dataset held 67,312 common SNPs. Finally, for each ethnicity we generated 55 random combinations of non look-alike pairs to test if the number of shared SNPs in our “ultra” look-alike population was more than expected by chance. Considering the European ancestry of the majority of “ultra” look-alike (6 out of 9) and non-“ultra” look-alike (7 out of 7) pairs in our study, we used the 7 non-“ultra” look-alike pairs with European ancestry to create 55 random combinations of 6 random non look-alike pairs to compute the number of shared SNPs with the same genotype as a proxy for the European population. For East Asia, Central-South Asia and Hispanic populations, we generated 55 random combinations of 1 random non look-alike 1000 Genomes pair to compute the number of shared SNPs in each of the aforementioned populations. Finally, the number of SNPs shared by “ultra” look-alike pairs in each population was tested for statistical significance enrichment against the background number of shared SNPs in each non look-alike population by means of the Pearson’s chi-squared test.Copy number variant (CNV) calling and functional annotationThe impact of CNVs on genes was calculated in two different ways. First, we looked at whole-gene CNVs, and then partially-overlapping CNVs. Copy number of all genes in the genome was calculated by first establishing CNV breakpoints. Breakpoints were assigned to the outermost SNP positions of regions with the same copy number. The breakpoints were calculated separately for each sample. Using these coordinates, the copy number of whole protein-coding and RNA genes was calculated for all individuals. Gene coordinates were obtained from Ensembl v75 (build GRCh37). We took the genes that had a shared copy number in all pairs of look-alikes (both individuals within the pair had the same number of copies), and we selected those genes for which at least one pair of look-alikes had a different number of copies than the rest of the pairs. For example, to look for partially-overlapping CNVs, we selected all positions in the genome in which the copy number matched within all pairs, but for which at least 2 pairs of lookalikes had a different copy number to the rest of the pairs. We then looked for overlaps with partial overlaps with coding or non-coding genes. As an example, region chr11:125778219-125780253, which overlaps with a lncRNA that has a regulatory relationship with the HYLS1 gene, there are three pairs of look-alikes that carry three copies of this lncRNA, while the remaining pairs have two copies of it. All custom R scripts for CNV analysis are deposited in GitHub repository: https://github.com/mesteller-bioinfolab/lookalike.CNV clustering and heatmapClustering of CNVs was done after filtering out all positions with the same copy number in all samples and merging all contiguous positions with the same copy number. Positions from the X and Y chromosomes that showed the same copy number in all males and the same copy number in all females were also filtered out. The clustering of the samples was calculated using pvclust (Suzuki and Shimodaira 2006). Variants represented in the heatmap are a random selection of one fifth of the total number of variants.Genome-wide SNP arrays from monozygotic twinsWe obtained single nucleotide polymorphism (SNP) data for 38 monozygotic twins from two publicly available studies. Both were downloaded from NCBI Gene Expression Omnibus (http://www.ncbi.nlm.nih.gov/geo) under accession No. GSE33598 and GSE9608. The signal raw intensities for each array were assessed and analyzed with GenomeStudio Software (v2.0.4) (Illumina) using default normalization to generate X and Y intensity values for A and B alleles (generic labels for two alternative SNP alleles), respectively. All downstream analyses were performed in the R statistical environment (v3.6.1) (https://www.R-project.org/).Cryptic relatednessRobust relatedness inference and genetic correlation estimates between monozygotic twins, look-alike pairs and random non look-alikes were calculated using the software KING (Kinship-based INference for GWAS) (version 2.2.3). Student's t-test was applied to calculate statistical significance between populations.Ancestry assessmentGenotyping was performed using GenomeStudio v2.0.5; PACKPED Plink files were created using the software PLINK Input Report Plug-in v2.1.4 (https://emea.support.illumina.com/downloads/genomestudio-2-0-plugins.html). To analyze the look-alike pairs in the context of world-wide genetic diversity, their genomic data was merged using with 1,980 West-Eurasian, Asian and Native American individuals genotyped in the Affimetrix HO array (Lazaridis et al., 2014); the remaining dataset held 175,469 common SNPs. Principal Component Analysis (PCA) was generated with the HO individuals. Look-Alike individuals were then projected onto the first two components (PC1 and PC2) using options ‘lsqproject: YES’ and ‘shrinkmode: YES’ of smartpca built-in module of EIGENSOFT (v. 7.2.1) (Patterson et al., 2006; Weir et al., 2014) (https://www.hsph.harvard.edu/alkes-price/software/).Kinship assessmentKinship coefficients between look-alike pairs was first estimated with PLINK. PLINK uses a method-of-moments approach where the total proportion of shared SNPs IBD is calculated based on the estimated allele frequency of all SNPs in a dataset assumed to be homogeneous (Purcell et al., 2007). PLINK-indep-pairwise option was used with parameters 50 5 1.5. to generate a pruned subset of genotypes in low linkage disequilibrium of 282,122 SNPs in comparisons with 1000G dataset and 103,256 in comparisons with HO dataset; pairwise relatedness between individuals of each pair was calculated with the --genome--min-0.05 command to detect pairs with levels of IBD sharing compatible with up to a 3rd degree relationship (Manichaikul et al., 2010). Potential relatedness between pairs was subsequently explored by estimating long (>10 cM) IBD blocks that might be indicative of co-ancestry among individuals occurring in the last few hundreds or years (Ralph and Coop, 2013).Functional enrichment of shared SNPs using Gene OntologyEnrichment analysis was done with the enrichGO function from the clusterProfiler R package (Yu et al., 2012), using the org.Hs.eg.db genome annotation. The tested 3,730 genes annotated to the 19,277 SNPs with a matching genotype in all pairs of look-alikes. The background list of genes were all genes annotated to SNPs detected in HumanOmni5-Quad BeadChip analysis. Parameters minGSSize and maxGSSize from the enrichGO function were set to 1 and 22000, respectively, in order to capture all gene ontologies. Additional enrichment analyses were done using DAVID v6.8 and GOrilla.Enrichment of eQTLs in the look-alike SNPs set was calculated using data from the GTEx portal, release v7 (GTEx_Analysis_v7.metasoft.txt.gz). eQTLs with a fixed effect model p-values < 0.05 were selected for the analysis. A Fisher’s test was performed to calculate if the overlap between look-alike SNPs and eQTLs was bigger than expected by chance. The same enrichment analysis was done with each tissue independently, considering the eQTLs with a tissue-specific p-value <0.05. Gene ontology analysis was performed using GOrilla.Face gene enrichment in the identified SNPsIn order to statistically evaluate the face genes enrichment in our selected 19,277 SNPs corresponding to 3,730 genes shared by all “ultra” look-alike pairs, we gather all the genes related with face traits (face genes) from recent comprehensive genomic screenings related to facial shape (Claes et al., 2018; Xiong et al., 2019; White et al., 2021), the Facebase dataset (https://www.facebase.org/) and GWAS central (study HGVST1841, http://www.gwascentral.org) and applied two different approaches. In the first approach, we applied a hypergeometric test, as it is implemented in the R “phyper” function, from the package “stats”. In the second, we also performed a Monte Carlo simulation using 10,000 iterations. In each iteration, we selected a random set of 3,730 genes (the same number of genes in our 19,277 SNPs) from the total genes represented in the array (23,774 genes) and we counted the number of face genes found in this random selection. All the analyses were performed in R statistical programming language v.4.0.3.GWAS analysisThe overlap between matching sets of SNPs called from look-alike pairs and GWAS SNPs was performed using data from two GWAS databases: GWAS Catalog and GWAS Central. In GWAS Catalog v1.0.2, all GWAS SNPs were retrieved and lifted over from GRCh38 to GRCh37 using the R package liftOver. To calculate trait enrichment, we performed Fisher’s exact tests, computing matching genotypes from look-alike pairs against all SNPs detected in the HumanOmni5-Quad BeadChip. For GWAS Central analysis, studies related to facial morphology (HGVST1044, HGVST1625, HGVST1841, HGVST1892, HGVST1933, HGVST2265, HGVST2325, HGVST2359, HGVST2363 and HGVST2597) were selected. Fisher’s exact tests were performed to calculate significant overlaps in the different studies and correction for multiple testing was done with Benjamini and Hochberg’s adjustment method (α = 0.05). All custom R scripts for SNP functional analysis are deposited in GitHub repository: https://github.com/mesteller-bioinfolab/lookalike.GWAS functional enrichment of shared SNPs using S-LDSCIn order to determine the enrichment of GWAS signals for specific annotations we used the stratified LD score regression (S-LDSC) tool (github.com/bulik/ldsc). S-LDSC is a method to estimate heritability enrichment for selected functional annotations. To this end, we followed the partitioned heritability analysis tutorial (github.com/bulik/ldsc/wiki/Patitioned-Heritability) using the last and recommended version of the baseline-LD model (version 2.2) with 97 annotations. To asses the heritability enrichment of our 19,277 SNPs, we included a “look-alike” custom functional annotation, defined by the set of 19277 SNPs, on top of the baseline-LD model v2.2. Since S-LDSC is typically applied to large annotations, we included a 500-bp window around the set of 19,277 SNPs to define our custom “look-alike” functional annotation category, following the annotation format of the baseline-LD model v2.2. Considering the European ancestry of the majority of samples in our study, we performed the S-LDSC analysis using European LD scores and allele frequencies from the 1000 Genomes Phase 3 project. Full summary statistics available for “facial morphology” trait in European ancestry individuals were downloaded from GWAS Catalog, corresponding to two studies (Xiong et al., 2019; Hoskens et al., 2021). Finally, partition heritability analysis was performed with default parameters and facial traits with ES >1 and enrichment p value < 0.05 were considered.DNA methylation age estimationEpigenetic age estimation was computed using the Hannum method using the function methyAge from the ENmix R package (version 1.32.0).Multiomics clustering analysesTo genetically, epigenetically and metagenomically categorize inherent similarities between all look-alike pairs, shared SNV, CNV, DNA methylation and microbiota profiles, robust correlations and unsupervised hierarchical clustering with bootstrapping were performed with R function packages pvclust (Suzuki and Shimodaira 2006). Euclidean distance scores and ward.d2 minimum variance method were applied to attain hierarchical clustering represented as heatmaps using R statistical environment (v3.6.1). K-means clustering was also performed and represented using the first two dimensions of a Principal Component Analysis (PCA). To perform k-means clustering, 16 “centers” (clusters) were indicated. The SNP set was also visualized using t-SNE representation, selecting 2 dimensions and adjusting “perplexity” parameter to 6 and “max_iter” to 5,000. All the analysis were performed in R statistical programming language v.4.0.3 using the packages “SNPRelate”, “gdsfmt”,“stats”, “Rtsne”, “ggfortify” and “ggplot2”.Questionnaires processing and similarity analysisData obtained through questionnaires was transformed into a table, which was processed and transformed into numerical format with a custom script (deposited in GitHub; https://github.com/mesteller-bioinfolab/lookalike). In this script, all logical variables were transformed to 0 (False/No) and 1 (True/Yes). When the variables could be ordered (e.g. Never - Sometimes - Often), they were assigned numbers (0–1 - 2 in the example) that were afterwards normalized to 1. For non-sortable variables, the categories were split into logical columns (e.g. Employment category was split into three logical variables - Executive, Salaried and Own business). Finally, empty boxes were filled with the mode for each variable. Cosine similarity was calculated using the numerical matrix between all individuals. The look-alike intra and extra-pair distance analysis were defined and calculated as follows. Intra-pairs were defined as look-alike pairs that clustered in all three facial recognition software (n = 16). The extra-pairs were defined as all other combination pairs of non look-alikes in the initial 16 pairs. For 32 individuals, pairs of same individuals and their look-alike pair counterpart were removed, leaving 30 possible combinations per 16 pair (n = 480). The euclidean distances between each individual and all other samples were calculated using the dist function from the R package pvclust (Suzuki and Shimodaira 2006). Distances were calculated on SNP, CNV, methylome, quantitative and qualitative microbiome and questionnaire data. Intra-pair distances were compared to extra-pair distances using Student’s T test. Distance boxplots for independent variables were generated by calculating, for all possible pairs of samples, their absolute differences for each variable. We then classified all pairs between pairs of look-alikes and pairs of non-look-alikes. Finally, we calculated if the differences were significant with Wilcoxon rank sum tests.`
            },
            { // genetic algorithm
                "index": 0,
                "g_id": "EzmLDYVJtPAJ",
                "abstract": `Credit author statementEng Jet Yeo: Conceptualization, Methodology, Software, Validation, Writing – original draft. David M. Kennedy: Supervision. Fergal O'Rourke: Writing – review & editing, Supervision1. IntroductionRecently there has been an increase in the number of companies pursuing tidal current energy, using tidal current turbines (TCT), to tap into the relatively large unexploited tidal energy. Furthermore, some of the prototypes and projects have demonstrated successful commercialisation. One of such examples is Verdant Power's TCT, the company's grid-connected tidal power has exceeded performance projections by 40%, generating over 275 MWh over eight months of continued operation [1]. Another example is Magallanes Renovables, the company has successfully reinstalled their second generation 2 MW tidal platform ‘ATIR’ in April 2021 and connected to the national grid in the Fall of Warness in Orkney, Scotland [2]. The AR500 from SIMEC Atlantic Energy, installed in Naru Island, Japan, has made a recent milestone, the device has successfully passed one of the strongest tides of the year, followed by exhaustive inspection and verification of all the involved equipment. The device has also outputted more than 90 MWh of energy since the installation in January 2021 [3]. Despite the success of tidal energy devices for a number of companies, the tidal energy sector is still some way behind other mature renewable energy technologies, such as wind energy and this is evident in the large body of literature investigating the effects of different tidal current turbine designs under various operating conditions experienced at real tidal current energy sites [[4], [5], [6], [7], [8], [9]]. Optimisation of tidal current turbines plays a major role in improving the performance, life span and the economics. This is paramount to ensure full commercialisation of tidal current energy systems.The work presented in this paper focuses on a coupled multi-objective non-dominated sorting genetic algorithm (NSGA) and blade element momentum (BEM) theory. The BEM theory has been widely utilised in the wind industry and has proved to be one the most common and computationally efficient methods to predict the aerodynamic/hydrodynamic performance acting on the blades of wind turbines as well as TCTs [[10], [11], [12], [13], [14], [15]]. Vogel et al. [16] have comprehensively described the main difference between TCTs and wind turbines is the volume flux constrained flow field that occurs around TCTs. The authors have further extended the BEM theory to take into account the effects of flow confinement for the case of TCTs. Masters et al. [17] have presented a BEM model with the inclusion of Prandtl's correction model and have validated against the lifting line theory model and an industrial code, GH Tidal Bladed, the presented results have shown good correlations with the code. El-shahat et al. [18] found that the results of BEM theory were in good agreement with experimental data presented by Bahaj et al. [19] at low values of Ncrit parameter (Ncrit value is used to measure the free flow turbulence and to simulate the turbulent transition location in XFoil) when using the XFoil code for lift and drag coefficients. Using the same experimental data, the study undertaken by El-shahat et al. has also shown better thrust coefficient prediction and a more realistic power coefficient prediction over a range of tip speed ratios in their BEM model when compared to the SERG-Tidal model by Bahaj et al. [19].In addition to the BEM theory, the use of genetic algorithm (GA) has also been widely used as an optimisation tool in the wind industry and proven to save computational time. Early studies undertaken by Selig and Coverston-Caroll [20] have demonstrated the use of GA in wind turbine design to maximise the annual energy output by optimising the blade pitch, chord and twist distribution. Sessarego et al. [21] have used NSGA to optimise annual energy output and optimising the flap-wise bending moment of the wind turbine. There are many other studies done using GA in an attempt to further improve the performance of wind turbines and wind farm layout [[22], [23], [24], [25], [26], [27], [28], [29], [30], [31]]. As tidal current turbines share a number of similarities with wind turbines, a GA model can be similarly implemented to optimise a TCT blade. Sale [32] has used the coupled GA and BEM to optimise a TCT for an ideal power curve while avoiding cavitation inception. Kolekar and Banerjee [33] have used GA to improve power coefficient and reduced flap-wise bending stress by optimising pitch angles, tip speed ratios (TSR) and chord length, and it was further validated using CFD. Zhu et al. [34] have demonstrated the use of neural networks and GA to optimise a TCT blade and has shown improvement in power coefficient as well as for an expanded range of optimal tip speed ratios, the optimised TCT blade has been further validated against an experiment in a cavitation tunnel as well as sea trials on Xiushan island, Zhejiang province, China. Menéndez et al. [35] have used the surrogate-based optimisation method to replace the computationally expensive computational fluid dynamics (CFD) simulation in predicting the hydrodynamic performance of a TCT blade and utilised multi-objective GA to find the optimum blade geometry, the output blades as a result have shown improvement in terms of hydrodynamic performance when compared to their base case. There are many more studies presented in the literature proving that effectiveness and efficiency of using GA in terms of optimising TCT designs [[36], [37], [38], [39], [40], [41], [42]].The work presented in this paper is an optimisation tool for TCT blades using combined NSGA and an improved BEM model along with a NACA generator. Using an improved BEM model that accurately captures the downwash angle, a well-developed and reliable NSGA has also been used to improve the optimisation efficiency, resulting in a solver with higher fidelity. On top of that, the optimisation tool in this work incorporated a NACA generator that is capable of reproducing any NACA profile, such a tool allows the solver to analyse each and every profile used in each spanwise blade element. As a result, the model is very effective at producing tidal current turbine blades that have been optimised not only for local twist angle and chord length, but also for suitable NACA profiles to be used at a particular spanwise blade element. Additionally, this model also allows further implementation of other hydrofoil profiles that can be similarly generated using other approaches, expanding the capability to explore more hydrofoil profiles to be considered in the optimisation process. A set of Pareto optimal solutions have been produced in this work and each solution represents a completely unique tidal current turbine blade profile. Whereas other studies in the literature have used GA to only determine new hydrofoil profiles, optimising for the resulting lift and drag, and then used these results as model inputs into a BEM solver. The model used in this work focuses on maximising the power coefficient across a range of tip speed ratios while reducing the overall flap-wise bending moment by optimising for NACA profiles, twist angle and chord length at each blade element along the span of the tidal current turbine blade.2. TheoryIn this section, an improved blade element momentum (BEM) theory model is described, followed by a description of XFoil in terms of accuracy and the non-dominated sorting genetic algorithm (NSGA) employed in this work.2.1. Blade element momentum theoryIn a classic blade element momentum (BEM) theory, a few assumptions are made. The one-dimensional momentum theory assumes that the flow perpendicular to the rotor disc is steady, homogenous and incompressible. The rotor is assumed to have an infinite number of blades and no frictional drag between the turbine and the fluid. The static pressure of the fluid far upstream is equal to the static pressure of the fluid far downstream. For blade element theory the blade is divided into a number of spanwise blade elements, where each of the elements experience different fluid flow conditions due rotational velocity and the local element geometry such as hydrofoil profile, chord length, and twist angle.As previously described in another paper by the authors [43], the hydrodynamic parameters on each blade element are illustrated in Fig. 1. The angles in Fig. 1 consist of angle of attack, α, and relative angle of the tidal current flow, φ. Fig. 1 also includes the tangential force, dFtan, lift force, dFL, normal force, dFN, and drag force, dFD. The horizontal broken line in Fig. 1 represents the rotor plane.Download : Download high-res image (103KB)Download : Download full-size imageFig. 1. Section blade element diagram of a tidal current turbine showing angles, forces and velocities.The BEM theory initially uses an assumption of an infinite number of turbine blades, which is not realistic and has to be corrected. To improve the accuracy of the BEM, tip loss correction factor is employed. There are several tip loss correction models proposed in the literature such as Glauert's characteristic equation [44], Wilson et al. [45,46], Goldstein [47] and Shen's correction [48]. The correction model used in this research is a validated and improved model based on Shen's correction model by Zhong et al. [49]. The authors introduced two factors to the model, one is the downwash due to the three-dimensional effect, FS, and the other is due to the rotational effect, FR, as described in Equations (1), (2).(1)FR=2−2picos−1{exp[−2B(1−rR)1−λr2]}<math><mrow is="true"><msub is="true"><mi is="true">F</mi><mi is="true">R</mi></msub><mo linebreak="badbreak" is="true">=</mo><mn is="true">2</mn><mo linebreak="goodbreak" is="true">−</mo><mfrac is="true"><mn is="true">2</mn><mrow is="true"><mi is="true">p</mi><mi is="true">i</mi></mrow></mfrac><msup is="true"><mi is="true">cos</mi><mrow is="true"><mo is="true">−</mo><mn is="true">1</mn></mrow></msup><mrow is="true"><mo stretchy="true" is="true">{</mo><mrow is="true"><mi is="true">exp</mi><mrow is="true"><mo stretchy="true" is="true">[</mo><mrow is="true"><mo is="true">−</mo><mn is="true">2</mn><mi is="true">B</mi><mrow is="true"><mo stretchy="true" is="true">(</mo><mrow is="true"><mn is="true">1</mn><mo linebreak="badbreak" is="true">−</mo><mfrac is="true"><mi is="true">r</mi><mi is="true">R</mi></mfrac></mrow><mo stretchy="true" is="true">)</mo></mrow><msqrt is="true"><mrow is="true"><mn is="true">1</mn><mo linebreak="badbreak" is="true">−</mo><msubsup is="true"><mi is="true">λ</mi><mi is="true">r</mi><mn is="true">2</mn></msubsup></mrow></msqrt></mrow><mo stretchy="true" is="true">]</mo></mrow></mrow><mo stretchy="true" is="true">}</mo></mrow></mrow></math>(2)FS=2picos−1{exp[−(R−rc¯)34]}<math><mrow is="true"><msub is="true"><mi is="true">F</mi><mi is="true">S</mi></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mn is="true">2</mn><mrow is="true"><mi is="true">p</mi><mi is="true">i</mi></mrow></mfrac><msup is="true"><mi is="true">cos</mi><mrow is="true"><mo is="true">−</mo><mn is="true">1</mn></mrow></msup><mrow is="true"><mo stretchy="true" is="true">{</mo><mrow is="true"><mi is="true">exp</mi><mrow is="true"><mo stretchy="true" is="true">[</mo><mrow is="true"><mo is="true">−</mo><msup is="true"><mrow is="true"><mo stretchy="true" is="true">(</mo><mfrac is="true"><mrow is="true"><mi is="true">R</mi><mo linebreak="badbreak" is="true">−</mo><mi is="true">r</mi></mrow><mover accent="true" is="true"><mi is="true">c</mi><mo is="true">¯</mo></mover></mfrac><mo stretchy="true" is="true">)</mo></mrow><mfrac is="true"><mn is="true">3</mn><mn is="true">4</mn></mfrac></msup></mrow><mo stretchy="true" is="true">]</mo></mrow></mrow><mo stretchy="true" is="true">}</mo></mrow></mrow></math>where B<math><mrow is="true"><mi is="true">B</mi></mrow></math> is the number of blades, R<math><mrow is="true"><mi is="true">R</mi></mrow></math> is the radius of the turbine, r<math><mrow is="true"><mi is="true">r</mi></mrow></math> is the radial position of the blade element, λr<math><mrow is="true"><msub is="true"><mi is="true">λ</mi><mi is="true">r</mi></msub></mrow></math> is the local tip speed ratio and c¯<math><mrow is="true"><mover accent="true" is="true"><mi is="true">c</mi><mo is="true">¯</mo></mover></mrow></math> is the geometric mean chord length,(3)c¯=SR−r<math><mrow is="true"><mover accent="true" is="true"><mi is="true">c</mi><mo is="true">¯</mo></mover><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mi is="true">S</mi><mrow is="true"><mi is="true">R</mi><mo linebreak="badbreak" is="true">−</mo><mi is="true">r</mi></mrow></mfrac></mrow></math>where S is the blade area between the local radial position and the blade tip. In addition to the two new factors introduced by Zhong et al. Prandtl's tip loss correction factor [10], Ftip, is used and is described in Equation (4).(4)Ftip=2πcos−1[exp(B(R−r)2rsinφ)]<math><mrow is="true"><msub is="true"><mi is="true">F</mi><mrow is="true"><mi is="true">t</mi><mi is="true">i</mi><mi is="true">p</mi></mrow></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mn is="true">2</mn><mi is="true">π</mi></mfrac><msup is="true"><mi is="true">cos</mi><mrow is="true"><mo is="true">−</mo><mn is="true">1</mn></mrow></msup><mrow is="true"><mo stretchy="true" is="true">[</mo><mrow is="true"><mi is="true">exp</mi><mrow is="true"><mo stretchy="true" is="true">(</mo><mfrac is="true"><mrow is="true"><mi is="true">B</mi><mo stretchy="true" is="true">(</mo><mi is="true">R</mi><mo linebreak="badbreak" is="true">−</mo><mi is="true">r</mi><mo stretchy="true" is="true">)</mo></mrow><mrow is="true"><mn is="true">2</mn><mi is="true">r</mi><mspace width="0.25em" is="true"></mspace><mi is="true">sin</mi><mspace width="0.25em" is="true"></mspace><mi is="true">φ</mi></mrow></mfrac><mo stretchy="true" is="true">)</mo></mrow></mrow><mo stretchy="true" is="true">]</mo></mrow></mrow></math>Similarly, the hub loss model, Fhub, is employed to correct the induced velocity as a result of vortex shedding near the hub of the rotor.(5)Fhub=2πcos−1[exp(B(r−Rhub)2rsinφ)]<math><mrow is="true"><msub is="true"><mi is="true">F</mi><mrow is="true"><mi is="true">h</mi><mi is="true">u</mi><mi is="true">b</mi></mrow></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mn is="true">2</mn><mi is="true">π</mi></mfrac><msup is="true"><mi is="true">cos</mi><mrow is="true"><mo is="true">−</mo><mn is="true">1</mn></mrow></msup><mrow is="true"><mo stretchy="true" is="true">[</mo><mrow is="true"><mi is="true">exp</mi><mrow is="true"><mo stretchy="true" is="true">(</mo><mfrac is="true"><mrow is="true"><mi is="true">B</mi><mo stretchy="true" is="true">(</mo><mi is="true">r</mi><mo linebreak="badbreak" is="true">−</mo><msub is="true"><mi is="true">R</mi><mrow is="true"><mi is="true">h</mi><mi is="true">u</mi><mi is="true">b</mi></mrow></msub><mo stretchy="true" is="true">)</mo></mrow><mrow is="true"><mn is="true">2</mn><mi is="true">r</mi><mspace width="0.25em" is="true"></mspace><mi is="true">sin</mi><mspace width="0.25em" is="true"></mspace><mi is="true">φ</mi></mrow></mfrac><mo stretchy="true" is="true">)</mo></mrow></mrow><mo stretchy="true" is="true">]</mo></mrow></mrow></math>where Rhub radius of the rotor hub. The tip and hub losses can be multiplied to get the resulting losses, F = FhubFtip. As Zhong et al. described in his study, the lift and drag coefficients, CL and CD of the local blade element have to be corrected.(6)CL=1cos2αi(CL,ecosαi−CD,esinαi)<math><mrow is="true"><msub is="true"><mi is="true">C</mi><mi is="true">L</mi></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mn is="true">1</mn><mrow is="true"><msup is="true"><mrow is="true"><mi is="true">cos</mi><mspace width="0.25em" is="true"></mspace></mrow><mn is="true">2</mn></msup><msub is="true"><mi is="true">α</mi><mi is="true">i</mi></msub></mrow></mfrac><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><mi is="true">C</mi><mrow is="true"><mi is="true">L</mi><mo is="true">,</mo><mi is="true">e</mi></mrow></msub><mspace width="0.25em" is="true"></mspace><mi is="true">cos</mi><mspace width="0.25em" is="true"></mspace><msub is="true"><mi is="true">α</mi><mi is="true">i</mi></msub><mo linebreak="badbreak" is="true">−</mo><msub is="true"><mi is="true">C</mi><mrow is="true"><mi is="true">D</mi><mo is="true">,</mo><mi is="true">e</mi></mrow></msub><mspace width="0.25em" is="true"></mspace><mi is="true">sin</mi><mspace width="0.25em" is="true"></mspace><msub is="true"><mi is="true">α</mi><mi is="true">i</mi></msub><mo stretchy="true" is="true">)</mo></mrow></mrow></math>(7)CD=1cos2αi(CD,ecosαi+CL,esinαi)<math><mrow is="true"><msub is="true"><mi is="true">C</mi><mi is="true">D</mi></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mn is="true">1</mn><mrow is="true"><msup is="true"><mrow is="true"><mi is="true">cos</mi><mspace width="0.25em" is="true"></mspace></mrow><mn is="true">2</mn></msup><msub is="true"><mi is="true">α</mi><mi is="true">i</mi></msub></mrow></mfrac><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><mi is="true">C</mi><mrow is="true"><mi is="true">D</mi><mo is="true">,</mo><mi is="true">e</mi></mrow></msub><mspace width="0.25em" is="true"></mspace><mi is="true">cos</mi><mspace width="0.25em" is="true"></mspace><msub is="true"><mi is="true">α</mi><mi is="true">i</mi></msub><mo linebreak="badbreak" is="true">+</mo><msub is="true"><mi is="true">C</mi><mrow is="true"><mi is="true">L</mi><mo is="true">,</mo><mi is="true">e</mi></mrow></msub><mspace width="0.25em" is="true"></mspace><mi is="true">sin</mi><mspace width="0.25em" is="true"></mspace><msub is="true"><mi is="true">α</mi><mi is="true">i</mi></msub><mo stretchy="true" is="true">)</mo></mrow></mrow></math>where αi<math><mrow is="true"><msub is="true"><mi is="true">α</mi><mi is="true">i</mi></msub></mrow></math> is the downwash angle which is determined using Equation (8), CL,e<math><mrow is="true"><msub is="true"><mi is="true">C</mi><mrow is="true"><mi is="true">L</mi><mo is="true">,</mo><mi is="true">e</mi></mrow></msub></mrow></math> and CD,e<math><mrow is="true"><msub is="true"><mi is="true">C</mi><mrow is="true"><mi is="true">D</mi><mo is="true">,</mo><mi is="true">e</mi></mrow></msub></mrow></math> are the 2D hydrofoil's lift and drag coefficient at effective angle of attack, αe<math><mrow is="true"><msub is="true"><mi is="true">α</mi><mi is="true">e</mi></msub></mrow></math>.(8)αi=CL,2D(α)m(1−FS)<math><mrow is="true"><msub is="true"><mi is="true">α</mi><mi is="true">i</mi></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mrow is="true"><msub is="true"><mi is="true">C</mi><mrow is="true"><mi is="true">L</mi><mo is="true">,</mo><mn is="true">2</mn><mi is="true">D</mi></mrow></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><mi is="true">α</mi><mo stretchy="true" is="true">)</mo></mrow></mrow><mi is="true">m</mi></mfrac><mrow is="true"><mo stretchy="true" is="true">(</mo><mn is="true">1</mn><mo linebreak="badbreak" is="true">−</mo><msub is="true"><mi is="true">F</mi><mi is="true">S</mi></msub><mo stretchy="true" is="true">)</mo></mrow></mrow></math>where CL,2D(α)<math><mrow is="true"><msub is="true"><mi is="true">C</mi><mrow is="true"><mi is="true">L</mi><mo is="true">,</mo><mn is="true">2</mn><mi is="true">D</mi></mrow></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><mi is="true">α</mi><mo stretchy="true" is="true">)</mo></mrow></mrow></math> is the 2D hydrofoil's lift coefficient at the local angle of attack, α<math><mrow is="true"><mi is="true">α</mi></mrow></math>, and m<math><mrow is="true"><mi is="true">m</mi></mrow></math> is the curve slope of the linear zone of the hydrofoil lift coefficient profile before the stall angle. The axial induction factor, a, and the angular induction factor, a’, can then be calculated as shown in Equations (9), (10).(9)a=2+Y1−4Y1(1−FR)+Y122(1+FRY1)<math><mrow is="true"><mi is="true">a</mi><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mrow is="true"><mn is="true">2</mn><mo linebreak="badbreak" is="true">+</mo><msub is="true"><mi is="true">Y</mi><mn is="true">1</mn></msub><mo linebreak="badbreak" is="true">−</mo><msqrt is="true"><mrow is="true"><mn is="true">4</mn><msub is="true"><mi is="true">Y</mi><mn is="true">1</mn></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><mrow is="true"><mn is="true">1</mn><mo linebreak="badbreak" is="true">−</mo><msub is="true"><mi is="true">F</mi><mi is="true">R</mi></msub></mrow><mo stretchy="true" is="true">)</mo></mrow><mo linebreak="badbreak" is="true">+</mo><msubsup is="true"><mi is="true">Y</mi><mn is="true">1</mn><mn is="true">2</mn></msubsup></mrow></msqrt></mrow><mrow is="true"><mn is="true">2</mn><mrow is="true"><mo stretchy="true" is="true">(</mo><mrow is="true"><mn is="true">1</mn><mo linebreak="badbreak" is="true">+</mo><msub is="true"><mi is="true">F</mi><mi is="true">R</mi></msub><msub is="true"><mi is="true">Y</mi><mn is="true">1</mn></msub></mrow><mo stretchy="true" is="true">)</mo></mrow></mrow></mfrac></mrow></math>(10)a′=1(1−aFR)Y21−a−1<math><mrow is="true"><msup is="true"><mi is="true">a</mi><mo is="true">′</mo></msup><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mn is="true">1</mn><mrow is="true"><mfrac is="true"><mrow is="true"><mrow is="true"><mo stretchy="true" is="true">(</mo><mrow is="true"><mn is="true">1</mn><mo linebreak="badbreak" is="true">−</mo><mi is="true">a</mi><msub is="true"><mi is="true">F</mi><mi is="true">R</mi></msub></mrow><mo stretchy="true" is="true">)</mo></mrow><msub is="true"><mi is="true">Y</mi><mn is="true">2</mn></msub></mrow><mrow is="true"><mn is="true">1</mn><mo linebreak="badbreak" is="true">−</mo><mi is="true">a</mi></mrow></mfrac><mo linebreak="badbreak" is="true">−</mo><mn is="true">1</mn></mrow></mfrac></mrow></math>where(11)Y1=4FRsin2φσCnF1<math><mrow is="true"><msub is="true"><mi is="true">Y</mi><mn is="true">1</mn></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mrow is="true"><mn is="true">4</mn><msub is="true"><mi is="true">F</mi><mi is="true">R</mi></msub><msup is="true"><mrow is="true"><mi is="true">sin</mi><mspace width="0.25em" is="true"></mspace></mrow><mn is="true">2</mn></msup><mspace width="0.25em" is="true"></mspace><mi is="true">φ</mi></mrow><mrow is="true"><mi is="true">σ</mi><msub is="true"><mi is="true">C</mi><mi is="true">n</mi></msub><msub is="true"><mi is="true">F</mi><mn is="true">1</mn></msub></mrow></mfrac></mrow></math>(12)Y2=4FRsinφcosφσCtF1<math><mrow is="true"><msub is="true"><mi is="true">Y</mi><mn is="true">2</mn></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mrow is="true"><mn is="true">4</mn><msub is="true"><mi is="true">F</mi><mi is="true">R</mi></msub><mspace width="0.25em" is="true"></mspace><mi is="true">sin</mi><mspace width="0.25em" is="true"></mspace><mi is="true">φ</mi><mspace width="0.25em" is="true"></mspace><mi is="true">cos</mi><mspace width="0.25em" is="true"></mspace><mi is="true">φ</mi></mrow><mrow is="true"><mi is="true">σ</mi><msub is="true"><mi is="true">C</mi><mi is="true">t</mi></msub><msub is="true"><mi is="true">F</mi><mn is="true">1</mn></msub></mrow></mfrac></mrow></math>(13)F1=2πcos−1[exp(−g1B(R−r)2rsinφ)]<math><mrow is="true"><msub is="true"><mi is="true">F</mi><mn is="true">1</mn></msub><mspace width="0.25em" is="true"></mspace><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mn is="true">2</mn><mi is="true">π</mi></mfrac><msup is="true"><mi is="true">cos</mi><mrow is="true"><mo is="true">−</mo><mn is="true">1</mn></mrow></msup><mrow is="true"><mo stretchy="true" is="true">[</mo><mrow is="true"><mi is="true">exp</mi><mrow is="true"><mo stretchy="true" is="true">(</mo><mrow is="true"><mo is="true">−</mo><msub is="true"><mi is="true">g</mi><mn is="true">1</mn></msub><mfrac is="true"><mrow is="true"><mi is="true">B</mi><mo stretchy="true" is="true">(</mo><mi is="true">R</mi><mo linebreak="badbreak" is="true">−</mo><mi is="true">r</mi><mo stretchy="true" is="true">)</mo></mrow><mrow is="true"><mn is="true">2</mn><mi is="true">r</mi><mspace width="0.25em" is="true"></mspace><mi is="true">sin</mi><mspace width="0.25em" is="true"></mspace><mi is="true">φ</mi></mrow></mfrac><mspace width="0.25em" is="true"></mspace></mrow><mo stretchy="true" is="true">)</mo></mrow></mrow><mo stretchy="true" is="true">]</mo></mrow></mrow></math>(14)g1=exp[−0.125(Bλ−21)]+0.1<math><mrow is="true"><msub is="true"><mi is="true">g</mi><mn is="true">1</mn></msub><mspace width="0.25em" is="true"></mspace><mo linebreak="badbreak" is="true">=</mo><mi is="true">exp</mi><mrow is="true"><mo stretchy="true" is="true">[</mo><mrow is="true"><mo is="true">−</mo><mn is="true">0.125</mn><mrow is="true"><mo stretchy="true" is="true">(</mo><mrow is="true"><mi is="true">B</mi><mi is="true">λ</mi><mo linebreak="badbreak" is="true">−</mo><mn is="true">21</mn></mrow><mo stretchy="true" is="true">)</mo></mrow></mrow><mo stretchy="true" is="true">]</mo></mrow><mo linebreak="goodbreak" is="true">+</mo><mn is="true">0.1</mn></mrow></math>where σ<math><mrow is="true"><mi is="true">σ</mi></mrow></math> is the local solidity defined by σ=CB2πr<math><mrow is="true"><mi is="true">σ</mi><mo linebreak="goodbreak" linebreakstyle="after" is="true">=</mo><mfrac is="true"><mrow is="true"><mi is="true">C</mi><mi is="true">B</mi></mrow><mrow is="true"><mn is="true">2</mn><mi is="true">π</mi><mi is="true">r</mi></mrow></mfrac></mrow></math> where C is the chord length and B is the number of blades. The normal force coefficient, Cn<math><mrow is="true"><msub is="true"><mi is="true">C</mi><mi is="true">n</mi></msub></mrow></math>, and tangential force coefficient, Ct,<math><mrow is="true"><msub is="true"><mi is="true">C</mi><mi is="true">t</mi></msub><mo is="true">,</mo></mrow></math> are calculated as follows.(15)Cn=CLcosφ+CDsinφ<math><mrow is="true"><msub is="true"><mi is="true">C</mi><mi is="true">n</mi></msub><mo linebreak="badbreak" is="true">=</mo><msub is="true"><mi is="true">C</mi><mi is="true">L</mi></msub><mspace width="0.25em" is="true"></mspace><mi is="true">cos</mi><mspace width="0.25em" is="true"></mspace><mi is="true">φ</mi><mo linebreak="goodbreak" is="true">+</mo><msub is="true"><mi is="true">C</mi><mi is="true">D</mi></msub><mspace width="0.25em" is="true"></mspace><mi is="true">sin</mi><mspace width="0.25em" is="true"></mspace><mi is="true">φ</mi></mrow></math>(16)Ct=CLsinφ−CDcosφ<math><mrow is="true"><msub is="true"><mi is="true">C</mi><mi is="true">t</mi></msub><mo linebreak="badbreak" is="true">=</mo><msub is="true"><mi is="true">C</mi><mi is="true">L</mi></msub><mspace width="0.25em" is="true"></mspace><mi is="true">sin</mi><mspace width="0.25em" is="true"></mspace><mi is="true">φ</mi><mo linebreak="goodbreak" is="true">−</mo><msub is="true"><mi is="true">C</mi><mi is="true">D</mi></msub><mspace width="0.25em" is="true"></mspace><mi is="true">cos</mi><mspace width="0.25em" is="true"></mspace><mi is="true">φ</mi></mrow></math>When the axial induction factor, a<math><mrow is="true"><mi is="true">a</mi></mrow></math> becomes larger than the critical value, ac<math><mrow is="true"><msub is="true"><mi is="true">a</mi><mi is="true">c</mi></msub></mrow></math> = 1/3, the momentum theory is no longer valid and Glauert's correction is employed to calculate the local thrust coefficient, CT. This work uses a modified Glauert's correction by Shen et al. [48] which is compatible with the current improved BEM algorithm.(17)CT={4aF(1−aF),a<ac4[ac2F2+(1−2acF)aF],a≥ac<math><mrow is="true"><msub is="true"><mi is="true">C</mi><mi is="true">T</mi></msub><mo linebreak="badbreak" is="true">=</mo><mrow is="true"><mo stretchy="true" is="true">{</mo><mtable columnalign="left" is="true"><mtr columnalign="left" is="true"><mtd columnalign="left" is="true"><mrow is="true"><mn is="true">4</mn><mi is="true">a</mi><mi is="true">F</mi><mrow is="true"><mo stretchy="true" is="true">(</mo><mn is="true">1</mn><mo linebreak="badbreak" is="true">−</mo><mi is="true">a</mi><mi is="true">F</mi><mo stretchy="true" is="true">)</mo></mrow><mo is="true">,</mo><mspace width="0.25em" is="true"></mspace><mi is="true">a</mi><mo linebreak="badbreak" is="true">&lt;</mo><msub is="true"><mi is="true">a</mi><mi is="true">c</mi></msub></mrow></mtd></mtr><mtr columnalign="left" is="true"><mtd columnalign="left" is="true"><mrow is="true"><mn is="true">4</mn><mrow is="true"><mo stretchy="true" is="true">[</mo><msubsup is="true"><mi is="true">a</mi><mi is="true">c</mi><mn is="true">2</mn></msubsup><msup is="true"><mi is="true">F</mi><mn is="true">2</mn></msup><mo linebreak="badbreak" is="true">+</mo><mrow is="true"><mo stretchy="true" is="true">(</mo><mn is="true">1</mn><mo linebreak="badbreak" is="true">−</mo><mn is="true">2</mn><msub is="true"><mi is="true">a</mi><mi is="true">c</mi></msub><mi is="true">F</mi><mo stretchy="true" is="true">)</mo></mrow><mi is="true">a</mi><mi is="true">F</mi><mo stretchy="true" is="true">]</mo></mrow><mo is="true">,</mo><mspace width="0.25em" is="true"></mspace><mi is="true">a</mi><mo linebreak="badbreak" is="true">≥</mo><msub is="true"><mi is="true">a</mi><mi is="true">c</mi></msub></mrow></mtd></mtr></mtable></mrow></mrow></math>The flapwise bending moment of the blade can be calculated with Equation (18), based on the assumption that the turbine blade is modelled as a cantilever beam supported at the blade root [50].(18)MB=1B∫0RrdT<math><mrow is="true"><msub is="true"><mi is="true">M</mi><mi is="true">B</mi></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mn is="true">1</mn><mi is="true">B</mi></mfrac><munderover is="true"><mrow is="true"><mo is="true">∫</mo></mrow><mn is="true">0</mn><mi is="true">R</mi></munderover><mi is="true">r</mi><mi is="true">d</mi><mi is="true">T</mi></mrow></math>where(19)dT=12ρπCTU22rdr<math><mrow is="true"><mi is="true">d</mi><mi is="true">T</mi><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mn is="true">1</mn><mn is="true">2</mn></mfrac><mi is="true">ρ</mi><mi is="true">π</mi><msub is="true"><mi is="true">C</mi><mi is="true">T</mi></msub><msup is="true"><mi is="true">U</mi><mn is="true">2</mn></msup><mn is="true">2</mn><mi is="true">r</mi><mi is="true">d</mi><mi is="true">r</mi></mrow></math>and ρ<math><mrow is="true"><mi is="true">ρ</mi></mrow></math> is the density of seawater and dr is the blade element thickness.2.2. Reynolds number and XFoilXFoil is code that is used in the current study to analyse the lift and drag coefficients of the generated NACA hydrofoil profiles. As the lift and drag characteristics are the fundamental in accurately determining the axial and tangential forces on each blade element, the reliability of XFoil is paramount. Xfoil has been widely studied in the literature. Van Treuren [51] has performed experimental tests of wind turbine airfoils and have stated that the XFoil code is not robust enough for predicting the aerodynamic performance at low Reynolds number (below Re = 100,000). Similarly, Mack et al. [52] performed an analysis on a modified NACA 643–618 profile at low Reynolds numbers (Re = 64,200 and Re = 137,000) and have concluded that XFoil is not capable of capturing the effects of separated laminar boundary layer and the formation of a closed laminar separation bubble, leading to inaccuracy of results produced by XFoil.On the contrary, Van Treuren [51] have stated that the simulation results generated by XFoil are generally adequate at Reynolds number greater than 500,000 as the flow will stay attached to the airfoil. Timmer and Bak [53] have discussed and shown that XFoil and its extension RFoil have produced results with good agreement with measured data at Re = 6,000,000. Zhu et al. [54] have designed new airfoil profiles optimised for Re = 16 million using XFoil and the results are in good agreement with a CFD solver. Pires et al. [55] have conducted tests on the DU00W212 airfoil at high Reynolds numbers of 3, 6, 9, 12 and 15 million at the DNW high pressure wind tunnel in Göttingen. It was confirmed that as Reynolds numbers increase, the minimum drag decreases and maximum lift increases. There is negligible change in lift coefficients in the linear region (angle of attack between −7⁰ to 10⁰) at different tested Reynolds numbers. The test results have provided invaluable insights on the airfoil aerodynamic behaviour at high Reynolds numbers. Pires et al. have also performed tests of high Reynolds numbers (Re = 3,000,000 and Re = 6,000,000) at the wind tunnel of LM Wind Power. In the same article, the authors have compared the measured data with XFoil, It was shown that XFoil is capable of predicting results of good agreement by fine tuning the N-factor and Mach number [56]. A study conducted by Selig [57] has proven that XFoil is well suited for analysis of airfoils at Reynolds numbers (between Re = 100,000 and Re = 500,000). It was agreed by Morgado et al. [58] showing that XFoil remains an excellent airfoil design and analysis tool, providing sufficient accuracy at the phase of conceptual designs.Similar to Ouro et al. [59], the Reynolds numbers for the current work is based on the turbine rotor's diameter, described in Equation (20).(20)ReD=UDν<math><mrow is="true"><mi is="true">R</mi><msub is="true"><mi is="true">e</mi><mi is="true">D</mi></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mrow is="true"><mi is="true">U</mi><mi is="true">D</mi></mrow><mi is="true">ν</mi></mfrac></mrow></math>where U<math><mrow is="true"><mi is="true">U</mi></mrow></math> is the velocity of the fluid, D<math><mrow is="true"><mi is="true">D</mi></mrow></math> is the diameter of the rotor, and ν<math><mrow is="true"><mi is="true">ν</mi></mrow></math> is the kinematic viscosity of the fluid.2.3. Non-dominated sorting genetic algorithmThe genetic algorithms (GA) are part of evolutionary computation models that are capable of effectively and efficiently optimising problems with the process of biologically inspired operators such as natural selection, crossover and mutation. In nature, the natural selection ensures that individuals that are fitter than others are more likely to survive and produce offspring. The natural selection is a mechanism that assigns probabilities to the individuals, individuals with a higher fitness value are more likely to be selected and therefore contribute more to the production of the next generation. These probabilistic search procedures are designed to work on large data sets that can be represented by strings [60]. Each string can also be imagined as strands of chromosomes and in each chromosome, there are genes.In this work, with the blade element moment (BEM) model, the tidal current turbine blades were split into multiple blade elements to determine the local hydrodynamic performance. By specifying the operating condition and local blade element profile such as NACA profile, twist angle, and chord length, the BEM model outputs the local power and thrust coefficient as a result. The genes in the current GA model are represented by the local blade element profile, and the chromosomes can then be represented with tidal current turbine blades.There are four phases in the GA, namely Selection, Crossover, Mutation, and Repopulation. The selection will select pairs of blades based on their fitness value, a higher fitness value results in a higher chance of being selected to proceed in the next phase. The fitness functions employed in the current study are power coefficient at design tip speed ratio (TSR), f1<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></mrow></math>, mean power coefficient at plus and minus two steps of design TSR, f2<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub></mrow></math>, and the mean overall bending moment of the tidal current turbines across the range of TSR, f3<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub></mrow></math>. The fitness functions f1<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></mrow></math>, f2<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub></mrow></math>, and f3<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub></mrow></math> are described as follows:(21)f1=CP,i<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub><mo linebreak="badbreak" is="true">=</mo><msub is="true"><mi is="true">C</mi><mrow is="true"><mi is="true">P</mi><mo is="true">,</mo><mi is="true">i</mi></mrow></msub></mrow></math>(22)f2=∑i−2i+2CP,i5<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mrow is="true"><msubsup is="true"><mrow is="true"><mo is="true">∑</mo></mrow><mrow is="true"><mi is="true">i</mi><mo linebreak="badbreak" is="true">−</mo><mn is="true">2</mn></mrow><mrow is="true"><mi is="true">i</mi><mo linebreak="badbreak" is="true">+</mo><mn is="true">2</mn></mrow></msubsup><msub is="true"><mi is="true">C</mi><mrow is="true"><mi is="true">P</mi><mo is="true">,</mo><mi is="true">i</mi></mrow></msub></mrow><mn is="true">5</mn></mfrac></mrow></math>(23)f3=∑MBTSRn<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mrow is="true"><mo is="true">∑</mo><msub is="true"><mi is="true">M</mi><mi is="true">B</mi></msub></mrow><mrow is="true"><mi is="true">T</mi><mi is="true">S</mi><msub is="true"><mi is="true">R</mi><mi is="true">n</mi></msub></mrow></mfrac></mrow></math>where i is the designed TSR and MB is the bending moment of the blade.The blades are selected with the proportional roulette wheel function described in Equation (24), where Fv is the fitness value of the blade, Ftotal is the sum of fitness values of the current population and Fn is the normalised fitness value of the tidal current turbine blade.(24)Fn=FvFtotal<math><mrow is="true"><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><msub is="true"><mi is="true">F</mi><mi is="true">v</mi></msub><msub is="true"><mi is="true">F</mi><mrow is="true"><mi is="true">t</mi><mi is="true">o</mi><mi is="true">t</mi><mi is="true">a</mi><mi is="true">l</mi></mrow></msub></mfrac></mrow></math>The proportional roulette wheel selection allows all the individuals to be selected, the selection chance of each individual is directly proportional to their fitness value. Therefore, individuals with high fitness values are selected with greater likelihood than individuals with low fitness values.Once a pair of blades are selected, they will undergo crossover or known as recombination, exchanging local blade element profiles such as the hydrofoil profile, twist angle and/or chord length, depending on the specified crossover probability, PC, inheriting the characteristics of both parent blade parameters, producing a pair of potentially better performing tidal current turbine blades in the next generation. The crossover of parameters will only happen between the blade section of the same radial position, for example, sections towards blade root will not be cross-overed with sections towards the blade tip.Schimitt L.M [50]. discussed that mutation plays a key part in the random generator phase of the GA. If the crossover operation combined with fitness selection without mutation, the convergence effect for the algorithm will exhibit genetic drift, which is a phenomenon when the populations become genetically identical. The mutation mechanism randomly mutates a few of the genes of the post-crossover chromosomes, this allows the GA to explore solutions beyond the initial population. In the current work, mutation randomly occurs after the cross-over operation depending on the mutation probability, PM, to prevent pre-mature convergence and exploring solutions beyond the initial population set. The mutation may occur to change the local NACA profiles, randomly increase or decrease the twist angle and/or chord length, provide offspring blades with a wider variety of local blade element profiles. As a boundary condition set for the current study, each section is allowed to have up to a 10% change in parameter when mutation occurs to avoid drastic changes. The mutation and crossover theory is comprehensively detailed by Schimitt L. M [61].The last phase of the GA model in the current study is done by the non-dominated sorting method, hence non-dominated sorting genetic algorithm (NSGA). Each blade is evaluated to determine if the blade is dominated by others in the current population, all non-dominated tidal current turbine (TCT) blades are the Pareto optimal solution, or known as the Pareto Frontier in the current population. For example, in a case of two objective functions, f1<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></mrow></math> and f2<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub></mrow></math>, if any chromosome is not dominated by any other chromosomes in terms of f1<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></mrow></math> and f2<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub></mrow></math>, the non-dominated chromosomes are considered as the Pareto Front 1. Once a frontier has been determined, the sorting process will repeat for the entire population to search for Pareto Front 2, 3, 4 and so on. The TCT blades are sorted using the crowding distance method as described in Equations (25) to (26)(25)CDi,nf1=Fn(f1i+1)−Fn(f1i−1)Fn(f1max)−Fn(f1min)<math><mrow is="true"><mi is="true">C</mi><msub is="true"><mi is="true">D</mi><mrow is="true"><mi is="true">i</mi><mo is="true">,</mo><msub is="true"><mi is="true">n</mi><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></msub></mrow></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mrow is="true"><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub><mrow is="true"><mi is="true">i</mi><mo linebreak="badbreak" is="true">+</mo><mn is="true">1</mn></mrow></msub><mo stretchy="true" is="true">)</mo></mrow><mo linebreak="badbreak" is="true">−</mo><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><mi is="true">f</mi><msub is="true"><mn is="true">1</mn><mrow is="true"><mi is="true">i</mi><mo linebreak="badbreak" is="true">−</mo><mn is="true">1</mn></mrow></msub></msub><mo stretchy="true" is="true">)</mo></mrow></mrow><mrow is="true"><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub><mrow is="true"><mi is="true">m</mi><mi is="true">a</mi><mi is="true">x</mi></mrow></msub><mo stretchy="true" is="true">)</mo></mrow><mo linebreak="badbreak" is="true">−</mo><mspace width="0.25em" is="true"></mspace><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub><mrow is="true"><mi is="true">m</mi><mi is="true">i</mi><mi is="true">n</mi></mrow></msub><mo stretchy="true" is="true">)</mo></mrow></mrow></mfrac></mrow></math>(26)CDi,nf2=Fn(f2i+1)−Fn(f2i−1)Fn(f2max)−Fn(f2min)<math><mrow is="true"><mi is="true">C</mi><msub is="true"><mi is="true">D</mi><mrow is="true"><mi is="true">i</mi><mo is="true">,</mo><msub is="true"><mi is="true">n</mi><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub></msub></mrow></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mrow is="true"><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub><mrow is="true"><mi is="true">i</mi><mo linebreak="badbreak" is="true">+</mo><mn is="true">1</mn></mrow></msub><mo stretchy="true" is="true">)</mo></mrow><mo linebreak="badbreak" is="true">−</mo><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><mi is="true">f</mi><msub is="true"><mn is="true">2</mn><mrow is="true"><mi is="true">i</mi><mo linebreak="badbreak" is="true">−</mo><mn is="true">1</mn></mrow></msub></msub><mo stretchy="true" is="true">)</mo></mrow></mrow><mrow is="true"><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub><mrow is="true"><mi is="true">m</mi><mi is="true">a</mi><mi is="true">x</mi></mrow></msub><mo stretchy="true" is="true">)</mo></mrow><mo linebreak="badbreak" is="true">−</mo><mspace width="0.25em" is="true"></mspace><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub><mrow is="true"><mi is="true">m</mi><mi is="true">i</mi><mi is="true">n</mi></mrow></msub><mo stretchy="true" is="true">)</mo></mrow></mrow></mfrac></mrow></math>(27)CDi,nf3=Fn(f3i+1)−Fn(f3i−1)Fn(f3max)−Fn(f3min)<math><mrow is="true"><mi is="true">C</mi><msub is="true"><mi is="true">D</mi><mrow is="true"><mi is="true">i</mi><mo is="true">,</mo><msub is="true"><mi is="true">n</mi><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub></msub></mrow></msub><mo linebreak="badbreak" is="true">=</mo><mfrac is="true"><mrow is="true"><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub><mrow is="true"><mi is="true">i</mi><mo linebreak="badbreak" is="true">+</mo><mn is="true">1</mn></mrow></msub><mo stretchy="true" is="true">)</mo></mrow><mo linebreak="badbreak" is="true">−</mo><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><mi is="true">f</mi><msub is="true"><mn is="true">3</mn><mrow is="true"><mi is="true">i</mi><mo linebreak="badbreak" is="true">−</mo><mn is="true">1</mn></mrow></msub></msub><mo stretchy="true" is="true">)</mo></mrow></mrow><mrow is="true"><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub><mrow is="true"><mi is="true">m</mi><mi is="true">a</mi><mi is="true">x</mi></mrow></msub><mo stretchy="true" is="true">)</mo></mrow><mo linebreak="badbreak" is="true">−</mo><mspace width="0.25em" is="true"></mspace><msub is="true"><mi is="true">F</mi><mi is="true">n</mi></msub><mrow is="true"><mo stretchy="true" is="true">(</mo><msub is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub><mrow is="true"><mi is="true">m</mi><mi is="true">i</mi><mi is="true">n</mi></mrow></msub><mo stretchy="true" is="true">)</mo></mrow></mrow></mfrac></mrow></math>(28)CDi=CDi,nf1+CDi,nf2+CDi,nf3<math><mrow is="true"><mi is="true">C</mi><msub is="true"><mi is="true">D</mi><mi is="true">i</mi></msub><mo linebreak="badbreak" is="true">=</mo><mi is="true">C</mi><msub is="true"><mi is="true">D</mi><mrow is="true"><mi is="true">i</mi><mo is="true">,</mo><msub is="true"><mi is="true">n</mi><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></msub></mrow></msub><mo linebreak="goodbreak" is="true">+</mo><mi is="true">C</mi><msub is="true"><mi is="true">D</mi><mrow is="true"><mi is="true">i</mi><mo is="true">,</mo><msub is="true"><mi is="true">n</mi><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub></msub></mrow></msub><mo linebreak="goodbreak" is="true">+</mo><mi is="true">C</mi><msub is="true"><mi is="true">D</mi><mrow is="true"><mi is="true">i</mi><mo is="true">,</mo><msub is="true"><mi is="true">n</mi><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub></msub></mrow></msub></mrow></math>for i=2,…,(l−1)<math><mrow is="true"><mspace width="0.25em" is="true"></mspace><mi is="true">i</mi><mo linebreak="goodbreak" linebreakstyle="after" is="true">=</mo><mn is="true">2</mn><mo is="true">,</mo><mspace width="0.25em" is="true"></mspace><mo is="true">…</mo><mo is="true">,</mo><mspace width="0.25em" is="true"></mspace><mrow is="true"><mo stretchy="true" is="true">(</mo><mrow is="true"><mi is="true">l</mi><mo linebreak="badbreak" is="true">−</mo><mn is="true">1</mn></mrow><mo stretchy="true" is="true">)</mo></mrow></mrow></math>,Where l<math><mrow is="true"><mi is="true">l</mi></mrow></math> is the total number of chromosomes in the Pareto Front Number, n<math><mrow is="true"><mi is="true">n</mi></mrow></math>, and f1<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></mrow></math>, f2<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub></mrow></math> and f3<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub></mrow></math> are objective function 1, 2 and 3 respectively. The crowding distance, CD for i=2<math><mrow is="true"><mi is="true">i</mi><mo linebreak="goodbreak" linebreakstyle="after" is="true">=</mo><mn is="true">2</mn></mrow></math> and i=l<math><mrow is="true"><mi is="true">i</mi><mo linebreak="goodbreak" linebreakstyle="after" is="true">=</mo><mi is="true">l</mi></mrow></math> is infinity. Once the CD is determined for the entire population, the TCT blades are sorted by CD in descending order. This mechanism ensures that TCT blades in the smallest Pareto Front Number will be selected for reservation in the next generation, then, TCT blades with furthest distance apart from each other in the same Pareto Front Number are prioritised to be reserved to the next generation. A detailed description of the Non-dominated Sorting theory used in NSGA-II can be found in Refs. [21,39,62,63].3. MethodologyThe coupled non-dominated sorting genetic algorithm – blade element momentum (NSGA-BEM) model begins by randomly generating tidal current turbine blades in the initial population, using the experimentally validated 63-8xx Series tidal current turbine blade [19,64] as a sample. A variety of NACA profiles are generated using the NACA Airfoil generator [65] and the lift and drag characteristic of each NACA profile are predicted using XFoil and stored in a virtual growing library, which allows the ease of access for the optimisation model, saving computational time. The integrated NSGA-BEM model is then let to run according to the parameters tabulated in Table 1.Table 1. Parameters of the NSGA-BEM model.ParametersValueMaximum number of generations300Population size100Crossover probability, PC0.8Mutation probability, PM0.2Design tip speed ratio6The optimisation process of the NSGA-BEM is illustrated in Fig. 2. After the initial population, all tidal current turbine (TCT) blades will go through BEM prediction and sorted before the NSGA sequence begins to iterate until the set number of generations is achieved. At the end of each generation, each TCT blade that has undergone crossover or mutation will go through the BEM prediction again to re-evaluate the new hydrodynamic performance. At the end of each generation, the population size will double the initial set amount, the TCT blades are sorted and any excess TCT blades beyond the population limit are eliminated from the current population pool. It is important to note that all TCT blades generated are stored as a different variable which can be used for data processing at the end of the sequence.Download : Download high-res image (112KB)Download : Download full-size imageFig. 2. The coupled non-dominated sorting genetic algorithm – blade element momentum theory optimisation process.4. Results and discussionThe coupled non-dominated sorting genetic algorithm – blade element momentum (NSGA-BEM) tool was let to run for 300 generations, 100 blade profiles in each generation and it took approximately 16 hours to complete on an Intel® Core™ i7-8750H CPU, producing a total of 30,000 blade profiles. Full details on the model outputs and results are given in subsections below.4.1. Validation of the current BEM solverThe accuracy of the improved blade element momentum (BEM) model was first validated against an experimentally validated tidal turbine blade profile, the NACA 63-8xx series by Bahaj et al. [19,64]. Fig. 3, Fig. 4 show the predicted power coefficient with measured data against tip speed ratio. There is only slight variation of the prediction of power coefficient over the range of tip speed ratios when compared with the measured data and there is a minor underprediction of thrust coefficient across the range of tip speed ratios (TSR) using the improved BEM model. The improved BEM model demonstrates competency at predicting the hydrodynamic forces acting on the tidal current turbine blade with a high degree of accuracy when compared to basic BEM model with Glauert's correction as shown in Fig. 3, Fig. 4. When the measured data is plotted against the predicted results as shown in Fig. 3, Fig. 4, a diagonal straight line is presented, the mean absolute error (MAE), coefficient of determination (R2<math><mrow is="true"><msup is="true"><mi is="true">R</mi><mn is="true">2</mn></msup></mrow></math>) and root mean squared error (RMSE) are determined. It can be seen that MAE, R2<math><mrow is="true"><msup is="true"><mi is="true">R</mi><mn is="true">2</mn></msup></mrow></math>, and RMSE of power coefficient are 0.01761, 0.99828 and 0.020317 respectively with a minor overestimation on average when comparing the predicted against measured values. In terms of thrust coefficient, the MAE, R2<math><mrow is="true"><msup is="true"><mi is="true">R</mi><mn is="true">2</mn></msup></mrow></math>, and RMSE were found to be 0.021971, 0.99488 and 0.025816 respectively with minor underestimation overall.Download : Download high-res image (279KB)Download : Download full-size imageFig. 3. (a) Comparison of predicted power coefficients and measured data versus tip speed ratio for the NACA 63-8xx Series tidal current turbine blade [19,64] and (b) Predicted power coefficients versus measured power coefficients of 63-8xx Series tidal current turbine blade.Download : Download high-res image (308KB)Download : Download full-size imageFig. 4. (a) Comparison of predicted thrust coefficients and measured data versus tip speed ratio for the NACA 63-8xx Series tidal current turbine blade [19,64], and (b) Predicted thrust coefficients versus measured thrust coefficients of 63-8xx Series tidal current turbine blade.4.2. Pareto solutionsThe coupled non-dominated sorting genetic algorithm – blade element momentum (NSGA-BEM) model has almost consistently generated 100 new turbine blade profiles in each generation, depending on a number of factors, such as the crossover probability, PC, mutation probability, PM, and selection probability of blades in the previous generation depending on the fitness function. Fig. 5 shows a 3-D plot of the three objective functions, where f1<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></mrow></math>, f2<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub></mrow></math>, and f3<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub></mrow></math> are in the x, y, and z axis of the plot respectively and as defined in Equation (21) – (23). Fig. 6(a) and Fig. 6(b) are the 2-D plots of the Pareto solution with f1<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></mrow></math> versus f2<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub></mrow></math> and f2<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">2</mn></msub></mrow></math> versus f3<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub></mrow></math>. In Fig. 5, Fig. 6, each of the generated tidal current turbine blade profiles are represented with dots, it can be seen that the sample blade, 63-8xx series is grouped in the dominated solutions as it was one of the sample blades in the first generation. The current model then attempted to search for better solutions for the set objective functions, resulting in 248 blade profiles in the Pareto frontier out of 30,000 blade profiles. The selection of the solution was undertaken manually, Solution 1 was selected with the highest f1<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></mrow></math> value, Solution 2 was selected for minimum f3<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub></mrow></math> value while having the f1<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">1</mn></msub></mrow></math> value higher than 0.47, and finally, Solution 3 was selected between the two extremes.Download : Download high-res image (329KB)Download : Download full-size imageFig. 5. 3-D plot of the Pareto solutions, each dot represents a tidal turbine blade profile.Download : Download high-res image (395KB)Download : Download full-size imageFig. 6. 2-D plot of the Pareto solutions, (a) f1 versus f2 and (b) f2 versus f3.4.3. Optimised bladesThe three selected blades all have slight variations to at each blade element and are tabulated in Table 2, Table 3, Table 4. The blade profiles are also illustrated in Fig. 7, Fig. 8, Fig. 9 and Selected Solution 1, 2 and 3 respectively. It is observed that all three selected solutions output contain the same NACA profile which is the 6415 from radial position between 0.5 and 0.8, the last two sections of Solution 2 and 3 also output the same NACA profile, NACA 661413/2. These two NACA profiles are plotted in Fig. 10 to show and compare the lift and drag coefficients.Table 2. Blade profile of Selected Solution 1.r0.20.30.40.50.60.70.80.91.0NACA4421651,820632,8186415641564156415654,613654,612C/R0.15600.11340.10250.08700.07410.06460.05760.05540.0532γ (°)21.4215.2311.38.698.465.685.964.994.02Table 3. Blade profile of Selected Solution 2.r0.20.30.40.50.60.70.80.91.0NACA452324,021654,6196415641564156415661,413661,412C/R0.13250.12300.09650.10020.06670.06140.04890.05170.0545γ (°)25.1914.7414.1510.668.147.456.055.174.29Table 4. Blade profile of Selected Solution 3.r0.20.30.40.50.60.70.80.91.0NACA23,02224,020634,8196415641564156415661,413661,412C/R0.13250.13500.10510.09960.07370.06520.06020.05170.0432γ (°)23.9315.6712.6510.258.627.626.245.174.10Download : Download high-res image (180KB)Download : Download full-size imageFig. 7. 2-D section view of blade profile of Selected Solution 1.Download : Download high-res image (165KB)Download : Download full-size imageFig. 8. 2-D section view of blade profile of Selected Solution 2.Download : Download high-res image (179KB)Download : Download full-size imageFig. 9. 2-D section view of blade profile of Selected Solution 3.Download : Download high-res image (185KB)Download : Download full-size imageFig. 10. Lift and drag coefficients of (a) NACA 6415 and (b) 661,412.4.4. Performance comparisonThe hydrodynamic performances for the selected solutions are plotted to compare with the sample blade as shown in Fig. 11 and Fig. 12. As shown in the figures, Selected Solution 1 outperforms the sample blade at a range of tip speed ratios (TSR) around a value of TSR = 5 and has a lower thrust coefficient for values lower than a TSR = 7, which is within the range of the specified designed TSR for the current study. Solution 2 and 3 showed similar performance characteristics, in terms of power and thrust coefficients, both solutions only outperform the sample blade at a TSR = 6 and above and slightly have an improved performance when compared to Solution 1 at a TSR = 9 and above. The thrust coefficients for both Solution 2 and 3 are lower across the range of TSRs with Solution 2 having the lowest thrust coefficients when compared with the other solutions, which is expected as it has the lowest f3<math><mrow is="true"><msub is="true"><mi is="true">f</mi><mn is="true">3</mn></msub></mrow></math> value.Download : Download high-res image (196KB)Download : Download full-size imageFig. 11. Power coefficient versus tip speed ratio for the three optimised tidal current turbine blades from E-GABEM (a) and NS-GABEM (b).Download : Download high-res image (210KB)Download : Download full-size imageFig. 12. Thrust coefficient versus tip speed ratio for the three optimised tidal current turbine blades from E-GABEM (a) and NS-GABEM (b).The bending moment of the blades at TSRs of 5, 6, and 7 are compared in Fig. 13, which shows that all three solutions have overall lower bending moments at all radial position, except for solution 1 which has a slightly higher bending moment at the blade tip. Solution 2 demonstrates the lowest bending moment across all radial position except for the blade tip where it is slightly higher than Solution 3. It is worth noting that these plots are predicted values using Equation (16) where R = 10 m.Download : Download high-res image (432KB)Download : Download full-size imageFig. 13. Comparison of bending moment of at each radial position for (a) TSR = 5, (b) TSR = 6, and (c) TSR = 7.The NSGA-BEM model in the current study outputs a large number of Pareto solutions, with 248 solutions in the Pareto Frontier, which helps narrow down the choices to select a suitable solution out of a total of 30,000 solutions. Each solution in the Pareto Frontier has its own advantages and trade-offs. In this study, Solution 1 demonstrates an overall increase in power coefficients when compared to the sample blade while having an overall slightly lower thrust coefficient. As a result, the tidal current turbine blade experiences overall lower bending moment. Solution 2 and 3, on the other hand, have demonstrated an overall lower thrust coefficient and bending moment but only slightly better in in terms of power coefficients at a TSR of 6 and above.5. ConclusionThe improved blade element momentum (BEM) theory was validated against an experimentally validated tidal current turbine blade, with coefficient of determination (R2) values of 0.99828 and 0.99488 for power and thrust coefficients respectively when compared against the measured data. Using XFoil to obtain the lift and drag coefficients of each NACA profile generated, the BEM model in the current study has demonstrated that it is capable of efficiently predicting the hydrodynamic performances of tidal current turbines to a high degree of accuracy.The work presented in this paper demonstrates a novel approach to combine non-dominated sorting genetic algorithm (NSGA) and the improved BEM model that is capable of accurately capturing the downwash angle, as well as a NACA generator that is capable of reproducing any NACA profile. Such a tool allows the solver to analyse each profile used in each spanwise blade element, producing tidal current turbine blades that have been optimised not only for local twist angle and chord length, but also for suitable NACA profiles to be used at a particular spanwise blade element. The NSGA-BEM model treats each spanwise blade element as a gene and each tidal current turbine (TCT) blade profile as a chromosome, the model has efficiently produced 30,000 TCT blade profiles in approximately 16 hours, 248 of which are in the Pareto Frontier (optimal solutions). Three solutions were manually selected from the Pareto Frontier base on several criteria and compared with measured data from a tidal current turbine blade. The findings have demonstrated an overall improvement in hydrodynamic performances as well as lowering the resulting bending moment experienced by the tidal current turbine blades. Further work will include computational fluid dynamics to extensively study the selected solutions and to validate the results presented in this paper.`
            },
        ]

        cosineSimilarity(docs, req.body.query, 1) // word dipenggal saja cth "life learning" -> "life", "learning"

        const docu = []
        for (let i = 0; i < docs.length; i++) {
            docu.push(docs[i].abstract)
        }

        const tf_idf = new TfIdf()
        tf_idf.createCorpusFromStringArray(
            docu
        )
        const search_result = tf_idf.rankDocumentsByQuery(req.body.query)
        for (let i = 0; i < search_result.length; i++) {
            docs[search_result[i].index].npmVal = search_result[i].similarityIndex
            docs[search_result[i].index].npmValxAbstractVal = (docs[search_result[i].index].npmVal + docs[search_result[i].index].abstractVal) * 0.5
        }

        let maxSenSim = sentenceSimilarity(docs, req.body.ogKeyword, 1)
        
        for (let i = 0; i < docs.length; i++) {
            docs[i].npmValxAbstractVal = (docs[i].npmVal + docs[i].abstractVal) * 0.5

            docs[i].finalValue = docs[i].abstractSenSim * docs[i].npmValxAbstractVal / maxSenSim
        }

        return res.status(200).json({
            'message': 'Query Success',
            'handmade' :docs,
            'npm': search_result,
            'status': 'Success'
        });
    }else{
        return res.status(401).json({
            'message': 'Inputan Belum lengkap!',
            'data':{
            },
            'status': 'Error'
        });
    }
});

// API Testing KMA
router.post('/kma', async (req, res) => {
    let journals = [
        {
            id: 0,
            abstractVal: 0.97,
            keywordsVal: 0.96,
            cited_count: 1.00
        },
        {
            id: 1,
            abstractVal: 0.94,
            keywordsVal: 0.95,
            cited_count: 0.98
        },
        {
            id: 2,
            abstractVal: 0.94,
            keywordsVal: 0.93,
            cited_count: 0.88
        },
        {
            id: 3,
            abstractVal: 0.95,
            keywordsVal: 0.90,
            cited_count: 0.87
        },
        {
            id: 4,
            abstractVal: 0.95,
            keywordsVal: 0.89,
            cited_count: 0.79
        },
        {
            id: 5,
            abstractVal: 0.91,
            keywordsVal: 0.84,
            cited_count: 0.80
        },
        {
            id: 6,
            abstractVal: 0.90,
            keywordsVal: 0.82,
            cited_count: 0.82
        },
        {
            id: 7,
            abstractVal: 0.88,
            keywordsVal: 0.79,
            cited_count: 0.85
        },
        {
            id: 8,
            abstractVal: 0.83,
            keywordsVal: 0.77,
            cited_count: 0.71
        },
        {
            id: 9,
            abstractVal: 0.78,
            keywordsVal: 0.79,
            cited_count: 0.69
        },
        {
            id: 10,
            abstractVal: 0.77,
            keywordsVal: 0.69,
            cited_count: 0.80
        },
        {
            id: 11,
            abstractVal: 0.60,
            keywordsVal: 0.85,
            cited_count: 0.73
        },
        {
            id: 12,
            abstractVal: 0.52,
            keywordsVal: 0.66,
            cited_count: 0.59
        },
        {
            id: 13,
            abstractVal: 0.45,
            keywordsVal: 0.23,
            cited_count: 0.57
        },
        {
            id: 14,
            abstractVal: 0.45,
            keywordsVal: 0.55,
            cited_count: 0.27
        },
        {
            id: 15,
            abstractVal: 0.33,
            keywordsVal: 0.22,
            cited_count: 0.15
        },
        {
            id: 16,
            abstractVal: 0.19,
            keywordsVal: 0.11,
            cited_count: 0.21
        },
        {
            id: 17,
            abstractVal: 0.31,
            keywordsVal: 0.24,
            cited_count: 0.12
        },
        {
            id: 18,
            abstractVal: 0.19,
            keywordsVal: 0.15,
            cited_count: 0.23
        },
        {
            id: 19,
            abstractVal: 0.13,
            keywordsVal: 0.22,
            cited_count: 0.15
        },
        {
            id: 20,
            abstractVal: 0.11,
            keywordsVal: 0.11,
            cited_count: 0.21
        },
        {
            id: 21,
            abstractVal: 0.77,
            keywordsVal: 0.77,
            cited_count: 0.80
        },
        {
            id: 22,
            abstractVal: 0.81,
            keywordsVal: 0.55,
            cited_count: 0.98
        },
    ]

    const newJournals = KMA(journals, journals.length, 15, 50, 3)

    return res.status(200).json({
        'message': 'Query Success',
        'data': {
            newJournals
        },
        'length': newJournals.length,
        'status': 'Success'
    });
});


module.exports = router