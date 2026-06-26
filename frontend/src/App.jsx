import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, MapPin, Building, Activity, Download, XCircle, AlertTriangle, Database, Zap } from 'lucide-react';
import Select from 'react-select';
import { Country, State } from 'country-state-city';
import ErrorBoundary from './ErrorBoundary';
import './index.css';

// Fallback segments if API is unavailable
const FALLBACK_SEGMENTS = [
  'IT & Software Companies',
  'Manufacturing Plants & Factories',
  'Healthcare & Hospitals',
  'Pharmaceutical Companies',
  'Real Estate Developers',
  'Construction Materials & Equipment',
  'Education & Training Institutes',
  'Finance, Banking & Insurance',
  'Retail & E-commerce Hubs',
  'Logistics & Supply Chain',
  'Food Processing & Beverage',
  'Textile & Garment Manufacturers',
  'Automotive & Auto Components',
  'Solar & Renewable Energy',
  'Chemical Industries',
  'Agriculture & Farming Equipment',
  'Solar EPC registered with MNRE',
  'Solar EPC not registered with MNRE',
  'Solar Project Developers',
  'Ceramic Tiles Manufacturers',
  'Vitrified Tiles Manufacturers',
  'Wall Tiles & Floor Tiles',
  'Sanitaryware & Bathroom Fittings',
  'Construction Materials & Building Products',
];

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const customStyles = {
  control: (provided, state) => ({
    ...provided,
    backgroundColor: state.isFocused ? '#0f1a3b' : '#0b132b',
    borderColor: state.isFocused ? '#d4af37' : 'rgba(255,255,255,0.1)',
    color: '#ffffff',
    borderRadius: '4px',
    minHeight: '28px',
    padding: '2px',
    boxShadow: state.isFocused ? '0 0 0 2px rgba(212, 175, 55, 0.2)' : 'none',
    transition: 'all 0.3s ease',
    '&:hover': { borderColor: '#d4af37' },
  }),
  menu: (provided) => ({
    ...provided,
    backgroundColor: '#0b132b',
    border: '1px solid #d4af37',
    borderRadius: '4px',
    boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
    zIndex: 100,
    fontSize: '0.85em',
  }),
  option: (provided, state) => ({
    ...provided,
    backgroundColor: state.isFocused ? 'rgba(212, 175, 55, 0.2)' : 'transparent',
    color: state.isFocused ? '#f1cf65' : '#ffffff',
    cursor: 'pointer',
    padding: '6px 10px',
    '&:active': { backgroundColor: 'rgba(212, 175, 55, 0.4)' },
  }),
  placeholder: (provided) => ({ ...provided, fontSize: '0.85em', color: '#64748b' }),
  singleValue: (provided) => ({ ...provided, color: '#ffffff', fontSize: '0.85em', fontWeight: 500 }),
  input: (provided) => ({ ...provided, color: '#ffffff' }),
};

function AppContent() {
  const [countries] = useState(() => Country.getAllCountries());
  const [states, setStates] = useState([]);

  const [selectedCountry, setSelectedCountry] = useState('');
  const [selectedCountryCode, setSelectedCountryCode] = useState('');
  const [selectedState, setSelectedState] = useState('');
  const [selectedCity, setSelectedCity] = useState('');
  const [industry, setIndustry] = useState('');
  const [customIndustry, setCustomIndustry] = useState('');

  const [searchDepth, setSearchDepth] = useState('medium');
  const [leads, setLeads] = useState([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [isScraping, setIsScraping] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [tabHidden, setTabHidden] = useState(false);
  const [validationError, setValidationError] = useState('');

  // Cache/DB state
  const [cacheInfo, setCacheInfo] = useState(null); // { cached, leadCount, lastScraped }
  const [sourceMode, setSourceMode] = useState(null); // 'cache' | 'live'

  // Segments loaded from DB
  const [industrySegments, setIndustrySegments] = useState(
    FALLBACK_SEGMENTS.map(name => ({ name, isCustom: false }))
  );

  const abortControllerRef = useRef(null);
  const readerRef = useRef(null);
  const isCancelledRef = useRef(false);
  const leadsMapRef = useRef(new Map());

  const [currentPage, setCurrentPage] = useState(1);
  const leadsPerPage = 50;
  const totalPages = Math.ceil(leads.length / leadsPerPage);
  const displayLeads = leads.slice((currentPage - 1) * leadsPerPage, currentPage * leadsPerPage);

  // ── Load segments from DB on startup ────────────────────────────────────────
  useEffect(() => {
    async function loadSegments() {
      try {
        const res = await fetch(`${API_BASE_URL}/api/segments`);
        if (res.ok) {
          const data = await res.json();
          if (data.segments && data.segments.length > 0) {
            setIndustrySegments(data.segments);
          }
        }
      } catch (e) {
        // Fallback to hardcoded list — already set as default state
      }
    }
    loadSegments();
  }, []);

  // ── Load leads from localStorage on startup ──────────────────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem('leads');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.length > 0) {
          setLeads(parsed);
          const map = new Map();
          parsed.forEach(l => map.set(l.companyName, l));
          leadsMapRef.current = map;
        }
      }
    } catch { /* ignore bad localStorage data */ }
  }, []);

  // ── Persist leads to localStorage ───────────────────────────────────────────
  useEffect(() => {
    if (leads.length > 0) {
      try { localStorage.setItem('leads', JSON.stringify(leads)); } catch { /* quota exceeded */ }
    }
  }, [leads]);

  // ── Warn when tab goes to background ────────────────────────────────────────
  useEffect(() => {
    const handleVisibility = () => setTabHidden(document.hidden);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // ── Check cache when industry/location changes ───────────────────────────────
  const checkCache = useCallback(async (ind, country, state, city) => {
    if (!ind || !country) { setCacheInfo(null); return; }
    try {
      const params = new URLSearchParams({
        industry: ind, country, state: state || '', city: city || '',
      });
      const res = await fetch(`${API_BASE_URL}/api/cache-check?${params}`);
      if (res.ok) {
        const data = await res.json();
        setCacheInfo(data);
      }
    } catch { setCacheInfo(null); }
  }, []);

  useEffect(() => {
    const finalIndustry = customIndustry || industry;
    checkCache(finalIndustry, selectedCountry, selectedState, selectedCity);
  }, [industry, customIndustry, selectedCountry, selectedState, selectedCity, checkCache]);

  // ── Load all leads from cache ────────────────────────────────────────────────
  const loadFromCache = async (ind, country, state, city) => {
    setIsScraping(true);
    setStatusMsg('Loading from database...');
    setSourceMode('cache');
    leadsMapRef.current = new Map();
    setLeads([]);
    setCurrentPage(1);
    setSkippedCount(0);

    try {
      let page = 1;
      let totalFetched = 0;
      const limit = 200;

      while (true) {
        const params = new URLSearchParams({
          industry: ind, country, state: state || '', city: city || '', page, limit,
        });
        const res = await fetch(`${API_BASE_URL}/api/leads?${params}`);
        if (!res.ok) break;

        const data = await res.json();
        const newLeads = data.leads || [];
        if (newLeads.length === 0) break;

        newLeads.forEach(lead => {
          if (!leadsMapRef.current.has(lead.companyName)) {
            leadsMapRef.current.set(lead.companyName, lead);
          }
        });
        setLeads(Array.from(leadsMapRef.current.values()));
        totalFetched += newLeads.length;
        setStatusMsg(`Loaded ${totalFetched} of ${data.total} leads from database...`);

        if (totalFetched >= data.total || newLeads.length < limit) break;
        page++;
      }

      setStatusMsg(`✅ ${totalFetched} leads loaded from database instantly!`);
    } catch (e) {
      setStatusMsg('Error loading from cache: ' + e.message);
    } finally {
      setIsScraping(false);
    }
  };

  // ── Location change handlers ─────────────────────────────────────────────────
  const handleCountryChange = (selectedOption) => {
    const cCode = selectedOption ? selectedOption.value : '';
    setSelectedCountryCode(cCode);
    const cObj = countries.find(c => c.isoCode === cCode);
    setSelectedCountry(cObj ? cObj.name : '');
    setSelectedState('');
    setSelectedCity('');
    if (cCode) {
      setStates(State.getStatesOfCountry(cCode));
    } else {
      setStates([]);
    }
  };

  const handleStateChange = (selectedOption) => {
    const sName = selectedOption ? selectedOption.value : '';
    setSelectedState(sName);
    setSelectedCity('');
  };

  // ── Save custom segment to DB ────────────────────────────────────────────────
  const saveCustomSegmentToDB = async (name) => {
    try {
      await fetch(`${API_BASE_URL}/api/segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      // Add to local dropdown immediately
      setIndustrySegments(prev => {
        if (prev.some(s => s.name === name)) return prev;
        return [...prev, { name, isCustom: true }];
      });
    } catch (e) {
      // Non-fatal — segment just won't be in DB
    }
  };

  // ── Start search (cache-first) ───────────────────────────────────────────────
  const startSearch = async (append = false) => {
    const finalIndustry = customIndustry || industry;
    if (!finalIndustry || !selectedCountry) {
      setValidationError('Please select at least a Country and an Industry.');
      return;
    }
    setValidationError('');

    // Save custom segment to DB
    if (customIndustry) {
      await saveCustomSegmentToDB(customIndustry);
    }

    // ── Cache-first check ──────────────────────────────────────────────────────
    if (!append && cacheInfo && cacheInfo.cached && cacheInfo.leadCount > 0) {
      await loadFromCache(finalIndustry, selectedCountry, selectedState, selectedCity);
      return;
    }

    // ── Live scrape ────────────────────────────────────────────────────────────
    setSourceMode('live');
    setIsScraping(true);
    isCancelledRef.current = false;
    if (!append) {
      leadsMapRef.current = new Map();
      setLeads([]);
      setCurrentPage(1);
      setSkippedCount(0);
    }
    setStatusMsg('Connecting to scraping server...');

    try {
      abortControllerRef.current = new AbortController();
      const response = await fetch(`${API_BASE_URL}/api/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countryCode: selectedCountryCode,
          country: selectedCountry,
          state: selectedState,
          city: selectedCity,
          industry: finalIndustry,
          searchDepth,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.body) throw new Error('ReadableStream not yet supported in this browser.');

      const reader = response.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder('utf-8');

      let lastChunkTime = Date.now();
      const connectionTimeout = setInterval(() => {
        if (Date.now() - lastChunkTime > 35000) {
          clearInterval(connectionTimeout);
          if (abortControllerRef.current) abortControllerRef.current.abort();
          if (readerRef.current) readerRef.current.cancel().catch(()=>{});
          setStatusMsg('Connection dropped. The server might have restarted or crashed.');
          setIsScraping(false);
        }
      }, 5000);

      while (true) {
        if (isCancelledRef.current) {
          reader.cancel().catch(()=>{});
          break;
        }
        
        const { done, value } = await reader.read();
        lastChunkTime = Date.now();
        if (done || isCancelledRef.current) break;

        const chunk = decoder.decode(value, { stream: true });
        const events = chunk.split('\n\n').filter(Boolean);

        events.forEach(eventStr => {
          if (eventStr.startsWith('event: ')) {
            const lines = eventStr.split('\n');
            const eventType = lines[0].replace('event: ', '').trim();
            const eventDataStr = lines[1] ? lines[1].replace('data: ', '').trim() : null;

            if (eventDataStr) {
              try {
                const data = JSON.parse(eventDataStr);
                if (eventType === 'status') {
                  setStatusMsg(data.message);
                  if (data.message.startsWith('Skipped')) {
                    setSkippedCount(prev => prev + 1);
                  }
                } else if (eventType === 'lead') {
                  const map = leadsMapRef.current;
                  if (!map.has(data.companyName)) {
                    map.set(data.companyName, { ...data, industry: finalIndustry });
                  } else {
                    const existing = map.get(data.companyName);
                    const merged = {
                      ...existing,
                      address:        data.address        || existing.address,
                      mobileNumber:   data.mobileNumber   || existing.mobileNumber,
                      landlineNumber: data.landlineNumber || existing.landlineNumber,
                      emailId:        data.emailId        || existing.emailId,
                      contactPerson:  data.contactPerson  || existing.contactPerson,
                      socials:        data.socials        || existing.socials,
                      website:        data.website        || existing.website,
                      contactPageUrl: data.contactPageUrl || existing.contactPageUrl,
                      description:    data.description    || existing.description,
                    };
                    map.set(data.companyName, merged);
                  }
                  setLeads(Array.from(map.values()));
                } else if (eventType === 'error') {
                  setStatusMsg('Error: ' + data.message);
                  setIsScraping(false);
                } else if (eventType === 'done') {
                  const savedMsg = data.savedToDB ? ' Results saved to shared database.' : '';
                  setStatusMsg(`Scraping completed. ${data.leadCount || 0} leads found.${savedMsg}`);
                  setIsScraping(false);
                  // Refresh cache info
                  checkCache(finalIndustry, selectedCountry, selectedState, selectedCity);
                }
              } catch (e) {
                console.error('Parse error', e);
              }
            }
          }
        });
      }
      clearInterval(connectionTimeout);
    } catch (error) {
      if (error.name === 'AbortError') {
        setStatusMsg('Search cancelled by user.');
      } else {
        setStatusMsg('Connection failed. Make sure backend is running.');
      }
      setIsScraping(false);
    }
  };

  const cancelSearch = () => {
    isCancelledRef.current = true;
    if (abortControllerRef.current) abortControllerRef.current.abort();
    if (readerRef.current) readerRef.current.cancel().catch(()=>{});
    setIsScraping(false);
    setStatusMsg('Search cancelled.');
  };

  const exportToCSV = () => {
    if (leads.length === 0) return;
    const headers = ['Company Name', 'Customer Segment', 'Address', 'Decision Makers (Predicted)', 'Mobile Number', 'Landline Number', 'Email ID', 'Website', 'Contact Page', 'Socials'];
    const csvRows = [headers.join(',')];

    for (const lead of leads) {
      const values = [
        lead.companyName,
        lead.industry,
        lead.address,
        lead.contactPerson,
        lead.mobileNumber   ? `="${lead.mobileNumber}"`   : '',
        lead.landlineNumber ? `="${lead.landlineNumber}"` : '',
        lead.emailId,
        lead.website,
        lead.contactPageUrl,
        lead.socials,
      ].map((val, idx) => {
        if ((idx === 4 || idx === 5) && val) return val;
        const str = String(val || '').replace(/"/g, '""');
        return `"${str}"`;
      });
      csvRows.push(values.join(','));
    }

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', `leads_${selectedState || selectedCountry}_${Date.now()}.csv`);
    a.click();
    window.URL.revokeObjectURL(url);
  };

  // ── Build segment options (predefined first, then custom) ────────────────────
  const segmentOptions = [
    {
      label: 'Predefined Segments',
      options: industrySegments
        .filter(s => !s.isCustom)
        .map(s => ({ value: s.name, label: s.name })),
    },
    {
      label: 'Custom Segments (Added by Users)',
      options: industrySegments
        .filter(s => s.isCustom)
        .map(s => ({ value: s.name, label: `✏️ ${s.name}` })),
    },
  ].filter(g => g.options.length > 0);

  const cacheDate = cacheInfo?.lastScraped
    ? new Date(cacheInfo.lastScraped).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '6px 12px', boxSizing: 'border-box', overflow: 'hidden' }}>
      <header style={{ textAlign: 'center', flexShrink: 0 }}>
        <h1 style={{ margin: 0, fontSize: '1.8em' }}>Lead Generator</h1>
        <p style={{ color: '#94a3b8', fontSize: '0.9em', margin: 0 }}>Intelligent Business Lead Generation</p>
      </header>

      <div style={{ display: 'flex', gap: '12px', flex: 1, minHeight: 0 }}>
        {/* Left Side: Filter Form */}
        <div className="glass-panel" style={{ flex: '0 0 380px', display: 'flex', flexDirection: 'column', gap: '4px', overflowY: 'auto', minHeight: 0, padding: '12px' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '4px', margin: 0, color: '#ffffff', fontSize: '0.85em' }}>
            <MapPin size={14} color="#d4af37" /> Location Setup
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <label style={{ fontSize: '0.8em', color: '#94a3b8' }}>Country</label>
            <Select
              styles={customStyles}
              options={countries.map(c => ({ value: c.isoCode, label: c.name }))}
              value={selectedCountryCode ? { value: selectedCountryCode, label: selectedCountry } : null}
              onChange={handleCountryChange}
              placeholder="-- Select or Search Country --"
              isClearable
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <label style={{ fontSize: '0.8em', color: '#94a3b8' }}>State / Province</label>
            <Select
              styles={customStyles}
              options={states.map(s => ({ value: s.name, label: s.name }))}
              value={selectedState ? { value: selectedState, label: selectedState } : null}
              onChange={handleStateChange}
              placeholder="-- Select or Search State --"
              isDisabled={!selectedCountryCode}
              isClearable
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <label style={{ fontSize: '0.8em', color: '#94a3b8' }}>City / Area (Optional)</label>
            <input
              type="text"
              placeholder="e.g. San Francisco, London..."
              value={selectedCity}
              onChange={(e) => setSelectedCity(e.target.value)}
              disabled={!selectedState && !selectedCountry}
            />
          </div>

          <h2 style={{ display: 'flex', alignItems: 'center', gap: '4px', margin: '6px 0 0 0', color: '#ffffff', fontSize: '0.85em' }}>
            <Building size={14} color="#d4af37" /> Industry Segment
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <label style={{ fontSize: '0.8em', color: '#94a3b8' }}>
              Predefined Segment {selectedCity ? `for ${selectedCity}` : selectedState ? `for ${selectedState}` : ''}
            </label>
            <Select
              styles={customStyles}
              options={segmentOptions}
              value={industry ? { value: industry, label: industry } : null}
              onChange={(selectedOption) => {
                setIndustry(selectedOption ? selectedOption.value : '');
                setCustomIndustry('');
              }}
              placeholder="-- Select or Search Segment --"
              isClearable
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <label style={{ fontSize: '0.8em', color: '#94a3b8' }}>Or Type Custom Industry</label>
            <input
              type="text"
              placeholder="e.g. Solar Panel Installers"
              value={customIndustry}
              onChange={(e) => { setCustomIndustry(e.target.value); setIndustry(''); }}
            />
          </div>

          {/* Cache Status Badge */}
          {cacheInfo && (customIndustry || industry) && selectedCountry && (
            <div style={{
              padding: '6px 8px',
              borderRadius: '4px',
              border: `1px solid ${cacheInfo.cached ? '#22c55e' : '#f59e0b'}`,
              background: cacheInfo.cached ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}>
              {cacheInfo.cached
                ? <Database size={12} color="#22c55e" />
                : <Zap size={12} color="#f59e0b" />}
              <div>
                {cacheInfo.cached ? (
                  <small style={{ color: '#22c55e', fontSize: '0.75em' }}>
                    <strong>⚡ {cacheInfo.leadCount} leads in database</strong> — will load instantly!
                    {cacheDate && <span style={{ color: '#94a3b8' }}> (scraped {cacheDate})</span>}
                  </small>
                ) : (
                  <small style={{ color: '#f59e0b', fontSize: '0.75em' }}>
                    <strong>No cache</strong> — will live-scrape and save for future users
                  </small>
                )}
              </div>
            </div>
          )}

          <div style={{ marginTop: '4px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px', color: '#ffffff', fontSize: '0.85em' }}>
              <Activity size={14} color="#d4af37" /> Search Depth
              {cacheInfo?.cached && <span style={{ color: '#22c55e', fontSize: '0.75em', marginLeft: '4px' }}>(ignored — using cache)</span>}
            </label>
            <div style={{ display: 'flex', gap: '4px' }}>
              {[
                { value: 'fast', label: 'Fast', color: '#22c55e' },
                { value: 'medium', label: 'Medium', color: '#f59e0b' },
                { value: 'deep', label: 'Deep', color: '#ef4444' },
              ].map(d => (
                <label key={d.value} style={{
                  display: 'flex', alignItems: 'center', gap: '4px', color: '#94a3b8', fontSize: '0.85em',
                  cursor: 'pointer', padding: '4px 8px', borderRadius: '4px',
                  background: searchDepth === d.value ? 'rgba(212, 175, 55, 0.15)' : 'transparent',
                  flex: 1, justifyContent: 'center',
                  opacity: cacheInfo?.cached ? 0.5 : 1,
                }}>
                  <input type="radio" name="searchDepth" value={d.value} checked={searchDepth === d.value}
                    onChange={() => setSearchDepth(d.value)}
                    style={{ accentColor: '#d4af37', width: '14px', height: '14px', cursor: 'pointer', margin: 0 }}
                  />
                  <span><strong style={{ color: d.color, fontSize: '0.85em' }}>{d.label}</strong></span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', padding: '0.5em 0.8em', fontSize: '0.8em',
                background: cacheInfo?.cached ? 'linear-gradient(135deg, #166534, #15803d)' : undefined }}
              onClick={() => startSearch(false)}
              disabled={isScraping || !selectedCountry || (!industry && !customIndustry)}
            >
              {isScraping
                ? <Activity className="animate-pulse" size={12} />
                : cacheInfo?.cached ? <Database size={12} /> : <Search size={12} />}
              {isScraping
                ? (sourceMode === 'cache' ? 'Loading from DB...' : 'Scraping...')
                : cacheInfo?.cached ? '⚡ Load from Database' : 'Start Search'}
            </button>
            {isScraping && (
              <button style={{ flex: '0 0 auto', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', display: 'flex', gap: '4px', alignItems: 'center', padding: '0.5em 0.8em', fontSize: '0.8em' }} onClick={cancelSearch}>
                <XCircle size={12} /> Cancel
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              onClick={() => startSearch(true)}
              disabled={isScraping}
              style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', background: 'transparent', border: '1px solid #d4af37', color: '#d4af37', boxShadow: 'none', padding: '0.5em 0.8em', fontSize: '0.8em' }}
            >
              <Search size={12} /> Add to Existing List
            </button>
            <button
              onClick={exportToCSV}
              disabled={leads.length === 0}
              style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', background: 'transparent', border: '1px solid #94a3b8', color: '#e2e8f0', boxShadow: 'none', cursor: leads.length === 0 ? 'not-allowed' : 'pointer', opacity: leads.length === 0 ? 0.6 : 1, padding: '0.5em 0.8em', fontSize: '0.8em' }}
            >
              <Download size={12} /> Export CSV
            </button>
            {leads.length > 0 && (
              <button
                onClick={() => { leadsMapRef.current = new Map(); setLeads([]); localStorage.removeItem('leads'); setCurrentPage(1); setCacheInfo(null); setSourceMode(null); }}
                style={{ flex: '0 0 auto', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', boxShadow: 'none', padding: '0.5em 0.8em', fontSize: '0.8em' }}
              >
                <XCircle size={12} /> Clear All
              </button>
            )}
          </div>

          {tabHidden && isScraping && (
            <div style={{ padding: '4px 6px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '4px', border: '1px solid #ef4444' }}>
              <small style={{ color: '#ef4444', fontSize: '0.75em' }}>⚠ Tab in background — scraping continues but results will appear when you switch back</small>
            </div>
          )}
          {validationError && (
            <div style={{ padding: '4px 6px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '4px', border: '1px solid #ef4444', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <AlertTriangle size={12} color="#ef4444" />
              <small style={{ color: '#ef4444', fontSize: '0.75em' }}>{validationError}</small>
            </div>
          )}
          {statusMsg && (
            <div style={{ padding: '4px 6px', background: 'rgba(212, 175, 55, 0.1)', borderRadius: '4px', border: '1px solid rgba(212, 175, 55, 0.3)' }}>
              <small style={{ color: '#e2e8f0', fontSize: '0.75em' }}>{statusMsg}</small>
            </div>
          )}
        </div>

        {/* Results Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, padding: '12px', minHeight: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1em', display: 'flex', alignItems: 'center', gap: '8px' }}>
                Leads Found ({leads.length})
                {sourceMode === 'cache' && (
                  <span style={{ fontSize: '0.7em', background: 'rgba(34,197,94,0.15)', border: '1px solid #22c55e', color: '#22c55e', padding: '2px 8px', borderRadius: '12px' }}>
                    ⚡ From Database
                  </span>
                )}
                {sourceMode === 'live' && (
                  <span style={{ fontSize: '0.7em', background: 'rgba(245,158,11,0.15)', border: '1px solid #f59e0b', color: '#f59e0b', padding: '2px 8px', borderRadius: '12px' }}>
                    🔍 Live Scrape
                  </span>
                )}
              </h2>
              {skippedCount > 0 && <p style={{ margin: 0, fontSize: '0.75em', color: '#f59e0b' }}>Skipped {skippedCount} companies missing mandatory Email/Phone</p>}
            </div>
          </div>

          <div style={{ overflowX: 'auto', overflowY: 'auto', marginTop: '6px', flex: 1, minHeight: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Company Name</th>
                  <th>Customer Segment</th>
                  <th>Address</th>
                  <th>Decision Makers (Predicted)</th>
                  <th>Mobile Number</th>
                  <th>Landline Number</th>
                  <th>Email ID</th>
                  <th>Website</th>
                  <th>Contact Page</th>
                  <th>Social Profiles</th>
                </tr>
              </thead>
              <tbody>
                {leads.length === 0 ? (
                  <tr>
                    <td colSpan="10" style={{ textAlign: 'center', padding: '30px', color: '#64748b' }}>
                      {isScraping ? 'Searching the web for matches...' : 'No leads generated yet. Start a search!'}
                    </td>
                  </tr>
                ) : (
                  displayLeads.map((lead, i) => (
                    <tr key={(currentPage - 1) * leadsPerPage + i}>
                      <td style={{ fontWeight: 600, color: '#ffffff' }}>{lead.companyName}</td>
                      <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lead.industry}>
                        {lead.industry || <div style={{ textAlign: 'center' }}>-</div>}
                      </td>
                      <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lead.address}>
                        {lead.address || <div style={{ textAlign: 'center' }}>-</div>}
                      </td>
                      <td style={{ maxWidth: '250px', whiteSpace: 'pre-wrap', fontSize: '0.85em' }}>
                        {lead.contactPerson || <div style={{ textAlign: 'center' }}>-</div>}
                      </td>
                      <td>{lead.mobileNumber || <div style={{ textAlign: 'center' }}>-</div>}</td>
                      <td>{lead.landlineNumber || <div style={{ textAlign: 'center' }}>-</div>}</td>
                      <td>
                        {lead.emailId
                          ? <a href={`mailto:${lead.emailId.split(',')[0]}`} style={{ color: '#d4af37' }}>{lead.emailId}</a>
                          : <div style={{ textAlign: 'center' }}>-</div>}
                      </td>
                      <td>
                        {lead.website
                          ? <a href={lead.website} target="_blank" rel="noreferrer" style={{ color: '#d4af37' }}>Link</a>
                          : <div style={{ textAlign: 'center' }}>-</div>}
                      </td>
                      <td>
                        {lead.contactPageUrl
                          ? <a href={lead.contactPageUrl} target="_blank" rel="noreferrer" style={{ color: '#d4af37' }}>Link</a>
                          : <div style={{ textAlign: 'center' }}>-</div>}
                      </td>
                      <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {lead.socials ? lead.socials.split(', ').map(link => (
                          <a key={link} href={link} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginRight: '8px', color: '#d4af37' }}>
                            {link.includes('linkedin') ? 'in' : link.includes('facebook') ? 'fb' : link.includes('twitter') ? 'tw' : link.includes('instagram') ? 'ig' : 'link'}
                          </a>
                        )) : <div style={{ textAlign: 'center' }}>-</div>}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', padding: '8px 0', flexShrink: 0 }}>
                <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage <= 1}
                  style={{ padding: '4px 12px', fontSize: '0.8em', background: 'transparent', border: '1px solid #d4af37', color: '#d4af37', borderRadius: '3px', cursor: currentPage <= 1 ? 'not-allowed' : 'pointer', opacity: currentPage <= 1 ? 0.5 : 1 }}>
                  Prev
                </button>
                <span style={{ color: '#94a3b8', fontSize: '0.85em' }}>Page {currentPage} of {totalPages}</span>
                <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}
                  style={{ padding: '4px 12px', fontSize: '0.8em', background: 'transparent', border: '1px solid #d4af37', color: '#d4af37', borderRadius: '3px', cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer', opacity: currentPage >= totalPages ? 0.5 : 1 }}>
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
