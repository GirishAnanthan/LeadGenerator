import { useState, useEffect, useRef } from 'react';
import { Search, MapPin, Building, Activity, Download, XCircle, AlertTriangle } from 'lucide-react';
import Select from 'react-select';
import { Country, State } from 'country-state-city';
import ErrorBoundary from './ErrorBoundary';
import './index.css';

// Predefined big commercial and industrial segments
const INDUSTRY_SEGMENTS = [
  "IT & Software Companies",
  "Manufacturing Plants & Factories",
  "Healthcare & Hospitals",
  "Pharmaceutical Companies",
  "Real Estate Developers",
  "Construction Materials & Equipment",
  "Education & Training Institutes",
  "Finance, Banking & Insurance",
  "Retail & E-commerce Hubs",
  "Logistics & Supply Chain",
  "Food Processing & Beverage",
  "Textile & Garment Manufacturers",
  "Automotive & Auto Components",
  "Solar & Renewable Energy",
  "Chemical Industries",
  "Agriculture & Farming Equipment",
  "Solar EPC registered with MNRE",
  "Solar EPC not registered with MNRE",
  "Solar Project Developers",
  "Ceramic Tiles Manufacturers",
  "Vitrified Tiles Manufacturers",
  "Wall Tiles & Floor Tiles",
  "Sanitaryware & Bathroom Fittings",
  "Construction Materials & Building Products"
];

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
    '&:hover': {
      borderColor: '#d4af37'
    }
  }),
  menu: (provided) => ({
    ...provided,
    backgroundColor: '#0b132b',
    border: '1px solid #d4af37',
    borderRadius: '4px',
    boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
    zIndex: 100,
    fontSize: '0.85em'
  }),
  option: (provided, state) => ({
    ...provided,
    backgroundColor: state.isFocused ? 'rgba(212, 175, 55, 0.2)' : 'transparent',
    color: state.isFocused ? '#f1cf65' : '#ffffff',
    cursor: 'pointer',
    padding: '6px 10px',
    '&:active': {
      backgroundColor: 'rgba(212, 175, 55, 0.4)'
    }
  }),
  placeholder: (provided) => ({ ...provided, fontSize: '0.85em', color: '#64748b' }),
  singleValue: (provided) => ({
    ...provided,
    color: '#ffffff',
    fontSize: '0.85em',
    fontWeight: 500
  }),
  input: (provided) => ({
    ...provided,
    color: '#ffffff'
  })
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
  const abortControllerRef = useRef(null);
  const leadsMapRef = useRef(new Map());

  const [currentPage, setCurrentPage] = useState(1);
  const leadsPerPage = 50;
  const totalPages = Math.ceil(leads.length / leadsPerPage);
  const displayLeads = leads.slice((currentPage - 1) * leadsPerPage, currentPage * leadsPerPage);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('leads');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.length > 0) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setLeads(parsed);
          const map = new Map();
          parsed.forEach(l => map.set(l.companyName, l));
          leadsMapRef.current = map;
        }
      }
    } catch { /* ignore bad localStorage data */ }
  }, []);

  useEffect(() => {
    if (leads.length > 0) {
      try { localStorage.setItem('leads', JSON.stringify(leads)); } catch { /* quota exceeded */ }
    }
  }, [leads]);

  // Warn when tab goes to background — browser throttles streaming in hidden tabs
  useEffect(() => {
    const handleVisibility = () => {
      setTabHidden(document.hidden);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const handleCountryChange = (selectedOption) => {
    const cCode = selectedOption ? selectedOption.value : '';
    setSelectedCountryCode(cCode);
    const cObj = countries.find(c => c.isoCode === cCode);
    setSelectedCountry(cObj ? cObj.name : '');

    // Reset child fields
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

  const startSearch = async (append = false) => {
    const finalIndustry = customIndustry || industry;
    if (!finalIndustry || !selectedCountry) {
      setValidationError('Please select at least a Country and an Industry.');
      return;
    }
    setValidationError('');

    setIsScraping(true);
    if (!append) {
      leadsMapRef.current = new Map();
      setLeads([]);
      setCurrentPage(1);
      setSkippedCount(0);
    }
    setStatusMsg('Connecting to scraping server...');

    try {
      abortControllerRef.current = new AbortController();
      const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const response = await fetch(`${API_BASE_URL}/api/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countryCode: selectedCountryCode,
          country: selectedCountry,
          state: selectedState,
          city: selectedCity,
          industry: finalIndustry,
          searchDepth: searchDepth
        }),
        signal: abortControllerRef.current.signal
      });

      if (!response.body) throw new Error('ReadableStream not yet supported in this browser.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

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
                    // Merge enriched data into the existing entry — don't drop the update
                    const existing = map.get(data.companyName);
                    const merged = {
                      ...existing,
                      address: data.address || existing.address,
                      mobileNumber: data.mobileNumber || existing.mobileNumber,
                      landlineNumber: data.landlineNumber || existing.landlineNumber,
                      emailId: data.emailId || existing.emailId,
                      contactPerson: data.contactPerson || existing.contactPerson,
                      socials: data.socials || existing.socials,
                      website: data.website || existing.website,
                      description: data.description || existing.description,
                    };
                    map.set(data.companyName, merged);
                  }
                  setLeads(Array.from(map.values()));
                } else if (eventType === 'error') {
                  setStatusMsg('Error: ' + data.message);
                  setIsScraping(false);
                } else if (eventType === 'done') {
                  setStatusMsg('Scraping completed.');
                  setIsScraping(false);
                }
              } catch (e) {
                console.error("Parse error", e);
              }
            }
          }
        });
      }
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
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsScraping(false);
    setStatusMsg('Search cancelled.');
  };

  const exportToCSV = () => {
    if (leads.length === 0) return;

    const headers = ['Company Name', 'Customer Segment', 'Address', 'Decision Makers (Predicted)', 'Mobile Number', 'Landline Number', 'Email ID', 'Website', 'Socials'];
    const csvRows = [headers.join(',')];

    for (const lead of leads) {
      const values = [
        lead.companyName,
        lead.industry,
        lead.address,
        lead.contactPerson,
        lead.mobileNumber ? `="${lead.mobileNumber}"` : '',
        lead.landlineNumber ? `="${lead.landlineNumber}"` : '',
        lead.emailId,
        lead.website,
        lead.socials
      ].map((val, idx) => {
        // If it's a mobile or landline formula, don't wrap it in extra quotes
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '6px 12px', boxSizing: 'border-box', overflow: 'hidden' }}>
      <header style={{ textAlign: 'center', flexShrink: 0 }}>
        <h1 style={{ margin: 0, fontSize: '1.8em' }}>Lead Scrapper</h1>
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
            <Select styles={customStyles} options={countries.map(c => ({ value: c.isoCode, label: c.name }))} value={selectedCountryCode ? { value: selectedCountryCode, label: selectedCountry } : null} onChange={handleCountryChange} placeholder="-- Select or Search Country --" isClearable />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <label style={{ fontSize: '0.8em', color: '#94a3b8' }}>State / Province</label>
            <Select styles={customStyles} options={states.map(s => ({ value: s.name, label: s.name }))} value={selectedState ? { value: selectedState, label: selectedState } : null} onChange={handleStateChange} placeholder="-- Select or Search State --" isDisabled={!selectedCountryCode} isClearable />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <label style={{ fontSize: '0.8em', color: '#94a3b8' }}>City / Area (Optional)</label>
            <input type="text" placeholder="e.g. San Francisco, London..." value={selectedCity} onChange={(e) => setSelectedCity(e.target.value)} disabled={!selectedState && !selectedCountry} />
          </div>

          <h2 style={{ display: 'flex', alignItems: 'center', gap: '4px', margin: '6px 0 0 0', color: '#ffffff', fontSize: '0.85em' }}>
            <Building size={14} color="#d4af37" /> Industry Segment
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <label style={{ fontSize: '0.8em', color: '#94a3b8' }}>Predefined Segment {selectedCity ? `for ${selectedCity}` : selectedState ? `for ${selectedState}` : ''}</label>
            <Select styles={customStyles} options={INDUSTRY_SEGMENTS.map(ind => ({ value: ind, label: ind }))} value={industry ? { value: industry, label: industry } : null} onChange={(selectedOption) => { setIndustry(selectedOption ? selectedOption.value : ''); setCustomIndustry(''); }} placeholder="-- Select or Search Segment --" isClearable />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <label style={{ fontSize: '0.8em', color: '#94a3b8' }}>Or Type Custom Industry</label>
            <input type="text" placeholder="e.g. Solar Panel Installers" value={customIndustry} onChange={(e) => { setCustomIndustry(e.target.value); setIndustry(''); }} />
          </div>

          <div style={{ marginTop: '4px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px', color: '#ffffff', fontSize: '0.85em' }}>
              <Activity size={14} color="#d4af37" /> Search Depth
            </label>
            <div style={{ display: 'flex', gap: '4px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#94a3b8', fontSize: '0.85em', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', background: searchDepth === 'fast' ? 'rgba(212, 175, 55, 0.15)' : 'transparent', flex: 1, justifyContent: 'center' }}>
                <input type="radio" name="searchDepth" value="fast" checked={searchDepth === 'fast'} onChange={() => setSearchDepth('fast')} style={{ accentColor: '#d4af37', width: '14px', height: '14px', cursor: 'pointer', margin: 0 }} />
                <span><strong style={{ color: '#22c55e', fontSize: '0.85em' }}>Fast</strong></span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#94a3b8', fontSize: '0.85em', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', background: searchDepth === 'medium' ? 'rgba(212, 175, 55, 0.15)' : 'transparent', flex: 1, justifyContent: 'center' }}>
                <input type="radio" name="searchDepth" value="medium" checked={searchDepth === 'medium'} onChange={() => setSearchDepth('medium')} style={{ accentColor: '#d4af37', width: '14px', height: '14px', cursor: 'pointer', margin: 0 }} />
                <span><strong style={{ color: '#f59e0b', fontSize: '0.85em' }}>Medium</strong></span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#94a3b8', fontSize: '0.85em', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', background: searchDepth === 'deep' ? 'rgba(212, 175, 55, 0.15)' : 'transparent', flex: 1, justifyContent: 'center' }}>
                <input type="radio" name="searchDepth" value="deep" checked={searchDepth === 'deep'} onChange={() => setSearchDepth('deep')} style={{ accentColor: '#d4af37', width: '14px', height: '14px', cursor: 'pointer', margin: 0 }} />
                <span><strong style={{ color: '#ef4444', fontSize: '0.85em' }}>Deep</strong></span>
              </label>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '4px' }}>
            <button style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', padding: '0.5em 0.8em', fontSize: '0.8em' }} onClick={() => startSearch(false)} disabled={isScraping || !selectedCountry || (!industry && !customIndustry)}>
              {isScraping ? <Activity className="animate-pulse" size={12} /> : <Search size={12} />}
              {isScraping ? 'Scraping...' : 'Start Search'}
            </button>
            {isScraping && (
              <button style={{ flex: '0 0 auto', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', display: 'flex', gap: '4px', alignItems: 'center', padding: '0.5em 0.8em', fontSize: '0.8em' }} onClick={cancelSearch}>
                <XCircle size={12} /> Cancel
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={() => startSearch(true)} disabled={isScraping} style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', background: 'transparent', border: '1px solid #d4af37', color: '#d4af37', boxShadow: 'none', padding: '0.5em 0.8em', fontSize: '0.8em' }}>
              <Search size={12} /> Add to Existing List
            </button>
            <button onClick={exportToCSV} disabled={leads.length === 0} style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', background: 'transparent', border: '1px solid #94a3b8', color: '#e2e8f0', boxShadow: 'none', cursor: leads.length === 0 ? 'not-allowed' : 'pointer', opacity: leads.length === 0 ? 0.6 : 1, padding: '0.5em 0.8em', fontSize: '0.8em' }}>
              <Download size={12} /> Export CSV
            </button>
            {leads.length > 0 && (
              <button onClick={() => { leadsMapRef.current = new Map(); setLeads([]); localStorage.removeItem('leads'); setCurrentPage(1); }} style={{ flex: '0 0 auto', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', boxShadow: 'none', padding: '0.5em 0.8em', fontSize: '0.8em' }}>
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
              <h2 style={{ margin: 0, fontSize: '1em' }}>Leads Found ({leads.length})</h2>
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
                        {lead.emailId ? <a href={`mailto:${lead.emailId.split(',')[0]}`} style={{ color: '#d4af37' }}>{lead.emailId}</a> : <div style={{ textAlign: 'center' }}>-</div>}
                      </td>
                      <td>
                        {lead.website ? (
                          <a href={lead.website} target="_blank" rel="noreferrer" style={{ color: '#d4af37' }}>Link</a>
                        ) : <div style={{ textAlign: 'center' }}>-</div>}
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
                <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage <= 1} style={{ padding: '4px 12px', fontSize: '0.8em', background: 'transparent', border: '1px solid #d4af37', color: '#d4af37', borderRadius: '3px', cursor: currentPage <= 1 ? 'not-allowed' : 'pointer', opacity: currentPage <= 1 ? 0.5 : 1 }}>
                  Prev
                </button>
                <span style={{ color: '#94a3b8', fontSize: '0.85em' }}>Page {currentPage} of {totalPages}</span>
                <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages} style={{ padding: '4px 12px', fontSize: '0.8em', background: 'transparent', border: '1px solid #d4af37', color: '#d4af37', borderRadius: '3px', cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer', opacity: currentPage >= totalPages ? 0.5 : 1 }}>
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
