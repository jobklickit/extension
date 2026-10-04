"""Browser DOM regression checks. Run with uv run --with playwright python tests/test_listings.py."""
from pathlib import Path
import argparse
import re
import tempfile
import unittest

from playwright.sync_api import sync_playwright

SOURCE = Path(__file__).resolve().parent.parent / 'src'
BROWSER = 'chromium'
MOCK = r"""
window.messages = [];
window.mockVotes = {};
window.mockSaved = {};
window.mockMode = 'mute';
window.mockExclusions = [];
window.storageListeners = [];
window.browser = {
  storage: {
    local: {set: async value => window.storageListeners.forEach(fn => fn({listingRevision:{}}, 'local'))},
    onChanged: {addListener: fn => window.storageListeners.push(fn)},
  },
  runtime: { sendMessage: async message => {
    window.messages.push(message);
    if (message.type === 'jobklick:preview') {
      return {ok: true, result: {preferences: {filter_mode: window.mockMode}, listings: message.listings.map(item => ({
        vote: window.mockVotes[item.url] || 0, saved: !!window.mockSaved[item.url],
        matched_skills: /Python/.test(item.text) ? ['Python'] : [], unmentioned_skills: ['English'], skill_count: 2,
        excluded_keywords: window.mockExclusions.filter(word => item.title.includes(word)),
        feedback: {positive: 0, negative: 0, examples: []},
      }))}};
    }
    if (message.type === 'jobklick:vote') {
      window.mockVotes[message.listing.url] = message.vote;
      return {ok: true, result: {vote: message.vote}};
    }
    if (message.type === 'jobklick:save') {
      if (window.failSave) return {ok:false, error:'Backend offline'};
      window.mockSaved[message.listing.url] = true;
      return {ok: true, result: {id: 1}};
    }
  }},
};
"""


class ListingDOMTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.profile = tempfile.TemporaryDirectory(prefix='jobklick-test-', dir=str(Path('/tmp').resolve()))
        cls.browser = getattr(cls.playwright, BROWSER).launch_persistent_context(cls.profile.name, headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.profile.cleanup()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])

    def load(self, url, content, setup=None, ad=None):
        # Full-ad fetches get `ad` when given; otherwise they see the list page and find no ad in it.
        self.page.route('**/*', lambda route: route.fulfill(
            body=ad if ad and 'stellenangebote--' in route.request.url else content, content_type='text/html'))
        self.page.goto(url)
        self.page.evaluate(MOCK)
        if setup:
            self.page.evaluate(setup)
        self.page.add_script_tag(path=str(SOURCE / 'listings.js'))
        self.page.wait_for_function("(document.querySelector('[data-jobklick-ui=listing]')?.shadowRoot.querySelector('.match').textContent ?? '…') !== '…'")

    def test_stepstone_url_keys_iterator_is_not_required(self):
        # Firefox content-script Xray wrappers can expose keys().next but not Symbol.iterator.
        self.page.set_default_timeout(3000)
        self.load('https://www.stepstone.de/jobs/vollzeit/data-science/in-72108-rottenburg-am-neckar', '''
          <article data-genesis-element="CARD" role="button" id="job-item-14537942" data-at="job-item" data-testid="job-item">
            <div data-testid="job-card-content"><a href="https://www.stepstone.de/cmp/de/pwc-2965/jobs">PwC</a>
              <h2><a data-at="job-item-title" data-testid="job-item-title" href="/stellenangebote--AI-Consultant-Public-Sector-Energy-w-m-d-PwC--14537942-inline.html?rltr=2_2_25_seorl_m_1_0_0_0_0_0&amp;utm_source=test&amp;lang=de"><div>AI-Consultant - Public Sector &amp; Energy (w/m/d)</div></a></h2>
              <p>Python</p></div></article>''', setup='''() => {
                const original = URLSearchParams.prototype.keys;
                URLSearchParams.prototype.keys = function() {
                  const iterator = original.call(this);
                  return {next: () => iterator.next()};
                };
              }''')
        self.page.get_by_role('button', name='Job speichern', exact=True).click()
        self.page.wait_for_function("messages.some(item=>item.type==='jobklick:save')")
        saved = self.page.evaluate("messages.find(item=>item.type==='jobklick:save').listing.url")
        self.assertEqual(saved, 'https://www.stepstone.de/stellenangebote--AI-Consultant-Public-Sector-Energy-w-m-d-PwC--14537942-inline.html?lang=de')

    def test_stepstone_reads_full_ad_in_background(self):
        ad = '<script type="application/ld+json">{"@type":"JobPosting","title":"Data","description":"<p>Wir suchen Python und SQL</p>"}</script>'
        self.load('https://www.stepstone.de/jobs/data', '''<article data-testid="job-item">
          <a data-at="job-item-title" href="/stellenangebote--Data--789-inline.html">Data</a><p>Berlin</p></article>''', ad=ad)
        self.page.wait_for_function("document.querySelector('[data-jobklick-ui=listing]').shadowRoot.querySelector('.match').title.includes('Vollständige Anzeige')")
        self.assertIn('1 Skill: Python', self.page.evaluate("document.querySelector('[data-jobklick-ui=listing]').shadowRoot.querySelector('.match').textContent"))
        self.page.get_by_role('button', name='Job speichern', exact=True).click()
        self.page.wait_for_function("messages.some(item=>item.type==='jobklick:save')")
        saved = self.page.evaluate("messages.find(item=>item.type==='jobklick:save')")
        self.assertEqual(saved['scope'], 'fetched')
        self.assertEqual(saved['listing']['text'], 'Data Wir suchen Python und SQL')
        self.assertEqual(saved['postings'][0]['title'], 'Data')

    def test_stepstone_scoped_capture_dynamic_cards_no_duplicates(self):
        self.load('https://www.stepstone.de/jobs/marketing', '''<article data-testid="job-item">
          <a data-at="job-item-title" href="/stellenangebote--Marketing--123-inline.html">Marketing</a><p>Python required</p></article>
          <script type="application/ld+json">[{"@type":"JobPosting","url":"https://www.stepstone.de/stellenangebote--Other--456-inline.html","title":"Other"}]</script>''')
        self.page.get_by_role('button', name='Job speichern', exact=True).click()
        self.page.get_by_role('button', name='✓ Gespeichert').wait_for()
        saved = self.page.evaluate("messages.find(item=>item.type==='jobklick:save')")
        self.assertEqual(saved['listing']['url'], 'https://www.stepstone.de/stellenangebote--Marketing--123-inline.html')
        self.assertEqual(saved['listing']['text'], 'Marketing Python required')
        self.assertEqual(saved['postings'], [])
        self.page.evaluate("document.querySelector('article').insertAdjacentHTML('beforeend','<span> English</span>')")
        self.page.wait_for_timeout(700)
        self.assertEqual(self.page.locator('[data-jobklick-ui=listing]').count(), 1)
        # Reuse the card for another job: no stale saved state or vote is inherited.
        self.page.evaluate("document.querySelector('a').href='/stellenangebote--Other--456-inline.html'; document.querySelector('a').textContent='Other'")
        self.page.get_by_role('button', name='Job speichern', exact=True).wait_for()
        self.page.get_by_role('button', name='Job speichern', exact=True).click()
        self.page.wait_for_function("messages.filter(item=>item.type==='jobklick:save').length===2")
        self.assertEqual(self.page.evaluate("messages.filter(item=>item.type==='jobklick:save')[1].postings[0].title"), 'Other')

    def test_indeed_votes_filters_and_restore(self):
        self.load('https://de.indeed.com/jobs?q=marketing', '''<div class="job_seen_beacon" onclick="window.cardClicks=(window.cardClicks||0)+1">
          <div class="resultContent"><h2 class="jobTitle"><a class="jcs-JobTitle" data-jk="abc" href="/rc/clk?jk=abc">Consultant</a></h2>
          <p>Python</p></div></div>''')
        self.page.get_by_role('button', name='Interessant', exact=True).click()
        self.page.wait_for_function("document.querySelector('[data-jobklick-ui=listing]').shadowRoot.querySelector('.up').getAttribute('aria-pressed')==='true'")
        self.assertEqual(self.page.evaluate('window.cardClicks || 0'), 0)
        self.page.get_by_role('button', name='Interessant', exact=True).click()
        self.page.wait_for_function("mockVotes['https://de.indeed.com/viewjob?jk=abc']===0")
        self.page.evaluate("mockExclusions=['Consultant']; storageListeners.forEach(fn=>fn({listingRevision:{}},'local'))")
        self.page.locator('[data-jobklick-muted]').wait_for()
        self.page.evaluate("mockMode='hide'; storageListeners.forEach(fn=>fn({listingRevision:{}},'local'))")
        self.page.get_by_role('button', name='jobklick.it · 1 ausgeblendet – anzeigen').click()
        self.page.get_by_role('button', name='Job speichern', exact=True).wait_for(state='visible')
        self.page.get_by_role('button', name='jobklick.it · 1 ausgeschlossene Stellen wieder ausblenden').click()
        self.page.locator('[data-jobklick-hidden]').wait_for(state='hidden')

    def test_linkedin_click_does_not_navigate_and_save_retries(self):
        self.load('https://www.linkedin.com/jobs/search/', '''<div class="base-card">
          <a class="base-card__full-link" href="https://de.linkedin.com/jobs/view/marketing-specialist-123456789/">Marketing Specialist</a><p>Python</p></div>''')
        self.page.evaluate('window.failSave=true')
        self.page.get_by_role('button', name='Job speichern', exact=True).click()
        self.page.get_by_text('Backend offline', exact=True).wait_for()
        self.page.evaluate('window.failSave=false')
        self.page.get_by_role('button', name='Erneut speichern').click()
        self.page.get_by_role('button', name='✓ Gespeichert').wait_for()
        self.assertEqual(self.page.url, 'https://www.linkedin.com/jobs/search/')
        # Below the card, not inside it: LinkedIn's card columns would squeeze the title.
        self.assertTrue(self.page.evaluate("document.querySelector('.base-card').nextElementSibling.dataset.jobklickUi === 'listing'"))
        self.assertEqual(self.page.evaluate("messages.find(item=>item.type==='jobklick:save').listing.url"), 'https://www.linkedin.com/jobs/view/123456789')

    def test_linkedin_card_without_ad_does_not_claim_no_skills(self):
        # LinkedIn cards carry only title, company and place: no match there is no verdict on the job.
        self.load('https://www.linkedin.com/jobs/search/', '''<div class="base-card">
          <a class="base-card__full-link" href="https://de.linkedin.com/jobs/view/recruiter-42/">Recruiter</a><p>RIZM · München</p></div>''')
        match = self.page.evaluate("document.querySelector('[data-jobklick-ui=listing]').shadowRoot.querySelector('.match').textContent")
        self.assertEqual(match, 'Skill-Abgleich: Anzeige öffnen')

    def test_detail_capture_and_matching_are_scoped_to_selected_job(self):
        self.load('https://de.indeed.com/jobs?vjk=abc', '''<div class="jobsearch-JobComponent"><h1>Python Developer</h1>
          <div id="jobDescriptionText">Full Python description</div></div><aside>Unrelated salesperson</aside>''')
        self.page.get_by_role('button', name='Job speichern', exact=True).click()
        self.page.wait_for_function("messages.some(item=>item.type==='jobklick:save')")
        saved = self.page.evaluate("messages.find(item=>item.type==='jobklick:save')")
        self.assertEqual(saved['scope'], 'detail')
        self.assertNotIn('salesperson', saved['listing']['text'])
        self.assertIn('Full Python description', saved['listing']['text'])

    def test_stepstone_detail_heading_and_saved_card_can_be_enriched(self):
        url = 'https://www.stepstone.de/stellenangebote--Data-Scientist--123-inline.html'
        self.load(url, '''<div data-at="job-ad-header"><h1 data-at="header-job-title">Data Scientist</h1></div>
          <div data-at="job-ad-content"><h2>Deine Aufgaben</h2><p>Python und SQL</p></div>''')
        self.page.evaluate("url => {mockSaved[url]=true; storageListeners.forEach(fn=>fn({listingRevision:{}},'local'))}", url)
        self.page.get_by_role('button', name='Anzeige erneut erfassen').click()
        self.page.wait_for_function("messages.some(item=>item.type==='jobklick:save')")
        saved = self.page.evaluate("messages.find(item=>item.type==='jobklick:save')")
        self.assertEqual(saved['scope'], 'detail')
        self.assertEqual(saved['listing']['title'], 'Data Scientist')
        self.assertIn('Python und SQL', saved['listing']['text'])


def check_captured_page(path, url):
    """Run the adapter against fetched markup without executing the site's remote scripts."""
    markup = re.sub(r'<script\b[^>]*>.*?</script>', '', Path(path).read_text(), flags=re.S | re.I)
    with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix='jobklick-test-', dir=str(Path('/tmp').resolve())) as profile:
        browser = getattr(playwright, BROWSER).launch_persistent_context(profile, headless=True, viewport={"width": 1440, "height": 1100})
        page = browser.new_page()
        page.route('**/*', lambda route: route.fulfill(body=markup, content_type='text/html')
                   if route.request.is_navigation_request() else route.abort())
        page.goto(url)
        page.evaluate(MOCK)
        page.add_script_tag(path=str(SOURCE / 'listings.js'))
        page.wait_for_selector('[data-jobklick-ui=listing]')
        cards = page.locator('article[data-testid="job-item"]').count()
        controls = page.get_by_role('button', name='Interessant', exact=True).count()
        assert controls >= cards > 0, (cards, controls)
        page.get_by_role('button', name='Interessant', exact=True).first.click()
        page.wait_for_function("messages.some(item=>item.type==='jobklick:vote')")
        page.wait_for_function("document.querySelector('[data-jobklick-ui=listing]').shadowRoot.querySelector('.match').textContent !== '…'")
        page.screenshot(path='/tmp/jobtracker-stepstone-controls.png', full_page=False)
        print(f'{BROWSER}: {cards} StepStone cards, {controls} voting controls; vote click delivered.')
        browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', choices=['chromium', 'firefox', 'webkit'], default='chromium')
    parser.add_argument('--page-html')
    parser.add_argument('--url')
    args, remaining = parser.parse_known_args()
    BROWSER = args.browser
    if args.page_html:
        if not args.url: parser.error('--page-html requires --url')
        check_captured_page(args.page_html, args.url)
    else:
        unittest.main(argv=[__file__, *remaining])


JOOBLE = """<!doctype html><meta charset="utf-8"><title>Jobs</title>
<header><nav><a href="/jobs/berlin">Jobs in Berlin</a><a href="/jobs/muenchen">Jobs in München</a><a href="/jobs/hamburg">Jobs in Hamburg</a></nav></header>
<main><div class="results">{cards}</div>
<div class="pager"><a href="?p=2">Seite 2</a> <a href="?p=3">Seite 3</a> <a href="?p=4">Seite 4</a></div></main>
<footer><a href="/impressum">Impressum und Kontakt</a><a href="/datenschutz">Datenschutz und Cookies</a><a href="/agb">AGB der Seite</a></footer>"""
CARD = """<article class="card c{n}"><header class="card-head"><h2><a class="title" href="/desc/{n}">{title}</a></h2></header>
<p>{company} · Berlin</p><p>{snippet}</p></article>"""


class PageScanTests(unittest.TestCase):
    """scan.js on a page the extension doesn't know: finds the listing cards, marks what fits, saves nothing."""

    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = getattr(cls.playwright, BROWSER).launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def test_finds_cards_and_marks_interesting_ones(self):
        page = self.browser.new_page()
        titles = ["Data Scientist (m/w/d)", "Verkäufer im Einzelhandel", "Python Entwickler Backend", "Lagerhelfer Frühschicht",
                  "Junior Data Analyst", "Koch für Kantine", "Machine Learning Engineer", "Bürokaufmann Teilzeit"]
        cards = "".join(CARD.format(n=n, title=t, company=f"Firma {n}", snippet="Wir suchen Verstärkung im Team.")
                        for n, t in enumerate(titles))
        page.route("**/*", lambda route: route.fulfill(body=JOOBLE.format(cards=cards), content_type="text/html"))
        page.goto("https://de.jooble.org/SearchResult?ukw=data")
        page.add_script_tag(path=str(SOURCE / "scan.js"))
        jobs = page.evaluate("jobklickScan()")
        self.assertEqual([job["title"] for job in jobs], titles)  # navigation, pager and footer left out
        self.assertEqual(jobs[0]["url"], "https://de.jooble.org/desc/0")
        self.assertIn("Firma 0", jobs[0]["text"])
        self.assertEqual(page.evaluate("document.querySelector('[data-jobklick-scan=\"0\"]').tagName"), "ARTICLE")  # the whole card
        results = [{"id": job["id"], "title": job["title"], "interest": "high" if "Data" in job["title"] else "none",
                    "matched_skills": [], "feedback": {"examples": [{"title": "Data Scientist", "vote": 1}]}} for job in jobs]
        results[2].update(interest="maybe", ai_reason="Python wie in deinem Profil")  # the AI pass: "vielleicht"
        marked = page.evaluate("r => jobklickMark(r, {ai: true})", results)
        self.assertEqual(marked, {"found": 8, "interesting": 2, "maybe": 1})
        self.assertEqual(page.evaluate("[...document.querySelectorAll('[data-jobklick-interest=high]')].map(el => el.querySelector('a').textContent)"),
                         ["Data Scientist (m/w/d)", "Junior Data Analyst"])
        panel = page.evaluate("document.querySelector('[data-jobklick-ui=scan]').shadowRoot.textContent")
        self.assertIn("2 passen, 1 vielleicht (von 8)", panel)
        self.assertIn("Ähnlich wie: Data Scientist", panel)  # the reason, not a score
        self.assertIn("KI: Python wie in deinem Profil", panel)
        self.assertEqual(page.evaluate("document.querySelector('[data-jobklick-scan=\"2\"]').dataset.jobklickInterest"), "maybe")
        page.close()

    def test_loads_listings_that_appear_on_scroll(self):
        page = self.browser.new_page(viewport={"width": 1000, "height": 600})
        first = "".join(CARD.format(n=n, title=f"Stelle Nummer {n}", company="Firma", snippet="Text") for n in range(8))
        # Like jooble: reaching the bottom appends the next 8 listings, twice.
        more = """<script>let batch = 1; addEventListener('scroll', () => {
          if (batch > 2 || innerHeight + scrollY < document.documentElement.scrollHeight - 5) return;
          const n0 = batch++ * 8; let html = '';
          for (let n = n0; n < n0 + 8; n++) html += `<article class="card"><header class="card-head"><h2><a class="title" href="/desc/${n}">Stelle Nummer ${n}</a></h2></header><p>Firma</p><p style="height:120px">Text</p></article>`;
          setTimeout(() => document.querySelector('.results').insertAdjacentHTML('beforeend', html), 200);
        });</script><style>article{height:200px}</style>"""
        page.route("**/*", lambda route: route.fulfill(body=JOOBLE.format(cards=first) + more, content_type="text/html"))
        page.goto("https://de.jooble.org/SearchResult?ukw=data")
        page.add_script_tag(path=str(SOURCE / "scan.js"))
        self.assertEqual(len(page.evaluate("jobklickScan()")), 8)
        page.evaluate("jobklickLoadMore()")
        self.assertEqual(len(page.evaluate("jobklickScan()")), 24)  # all three batches
        self.assertEqual(page.evaluate("scrollY"), 0)  # back where the user was
        page.close()
