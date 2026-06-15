import { useState, useEffect, useRef } from 'react';
import { Search, MapPin, Building, Activity, Download, XCircle } from 'lucide-react';
import Select from 'react-select';
import { Country, State, City } from 'country-state-city';
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
  "Solar Project Developers"
];

const customStyles = {
  control: (provided, state) => ({
    ...provided,
    backgroundColor: state.isFocused ? '#0f1a3b' : '#0b132b',
    borderColor: state.isFocused ? '#d4af37' : 'rgba(255,255,255,0.1)',
    color: '#ffffff',
    borderRadius: '4px',
    marginBottom: '16px',
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
    zIndex: 100
  }),
  option: (provided, state) => ({
    ...provided,
    backgroundColor: state.isFocused ? 'rgba(212, 175, 55, 0.2)' : 'transparent',
    color: state.isFocused ? '#f1cf65' : '#ffffff',
    cursor: 'pointer',
    padding: '10px 14px',
    '&:active': {
      backgroundColor: 'rgba(212, 175, 55, 0.4)'
    }
  }),
  singleValue: (provided) => ({
    ...provided,
    color: '#ffffff',
    fontWeight: 500
  }),
  input: (provided) => ({
    ...provided,
    color: '#ffffff'
  }),
  placeholder: (provided) => ({
    ...provided,
    color: '#64748b'
  })
};

function App() {
  const [countries, setCountries] = useState([]);
  const [states, setStates] = useState([]);
  
  const [selectedCountry, setSelectedCountry] = useState('');
  const [selectedCountryCode, setSelectedCountryCode] = useState('');
  const [selectedState, setSelectedState] = useState('');
  const [selectedCity, setSelectedCity] = useState('');
  const [industry, setIndustry] = useState('');
  const [customIndustry, setCustomIndustry] = useState('');
  
  const [leads, setLeads] = useState([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [isScraping, setIsScraping] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const abortControllerRef = useRef(null);

  useEffect(() => {
    // Load all countries on mount
    setCountries(Country.getAllCountries());
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
      alert("Please select at least a Country and an Industry.");
      return;
    }

    setIsScraping(true);
    if (!append) {
      setLeads([]);
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
          industry: finalIndustry
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
                   setLeads(prev => {
                     if (prev.some(l => l.companyName === data.companyName)) return prev;
                     return [...prev, { ...data, industry: finalIndustry }];
                   });
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
    
    const headers = ['Company Name', 'Customer Segment', 'Rating', 'Address', 'Decision Makers (Predicted)', 'Mobile Number', 'Landline Number', 'Email ID', 'Website', 'Socials'];
    const csvRows = [headers.join(',')];
    
    for (const lead of leads) {
      const values = [
        lead.companyName,
        lead.industry,
        lead.rating,
        lead.address,
        lead.contactPerson,
        lead.mobileNumber ? `="${lead.mobileNumber}"` : '',
        lead.landlineNumber ? `="${lead.landlineNumber}"` : '',
        lead.emailId,
        lead.website,
        lead.socials
      ].map((val, idx) => {
        // If it's a mobile or landline formula, don't wrap it in extra quotes
        if ((idx === 5 || idx === 6) && val) return val;
        
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
    <div style={{ maxWidth: '100%', margin: '0 auto', width: '100%', padding: '20px' }}>
      <header style={{ textAlign: 'center', margin: '20px 0 40px 0' }}>
        <h1>Lead Scrapper</h1>
        <p style={{ color: '#94a3b8', fontSize: '1.2em' }}>Intelligent Business Lead Generation</p>
      </header>

      <div style={{ display: 'flex', gap: '32px', justifyContent: 'center' }}>
        {/* Left Side: Filter Form */}
        <div className="glass-panel" style={{ flex: '0 0 420px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: 0, color: '#ffffff' }}>
            <MapPin size={20} color="#d4af37" /> Location Setup
          </h2>
          
          <label>Country</label>
          <Select 
            styles={customStyles}
            options={countries.map(c => ({ value: c.isoCode, label: c.name }))}
            value={selectedCountryCode ? { value: selectedCountryCode, label: selectedCountry } : null}
            onChange={handleCountryChange}
            placeholder="-- Select or Search Country --"
            isClearable
          />

          <label>State / Province</label>
          <Select 
            styles={customStyles}
            options={states.map(s => ({ value: s.name, label: s.name }))}
            value={selectedState ? { value: selectedState, label: selectedState } : null}
            onChange={handleStateChange}
            placeholder="-- Select or Search State --"
            isDisabled={!selectedCountryCode}
            isClearable
          />

          <label>City / Area (Optional)</label>
          <input 
            type="text" 
            placeholder="e.g. San Francisco, London..." 
            value={selectedCity}
            onChange={(e) => setSelectedCity(e.target.value)}
            disabled={!selectedState && !selectedCountry}
          />

          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '32px', color: '#ffffff' }}>
            <Building size={20} color="#d4af37" /> Industry Segment
          </h2>
          
          <label>Predefined Segment {selectedCity ? `for ${selectedCity}` : selectedState ? `for ${selectedState}` : ''}</label>
          <Select 
            styles={customStyles}
            options={INDUSTRY_SEGMENTS.map(ind => ({ value: ind, label: ind }))}
            value={industry ? { value: industry, label: industry } : null}
            onChange={(selectedOption) => { setIndustry(selectedOption ? selectedOption.value : ''); setCustomIndustry(''); }}
            placeholder="-- Select or Search Segment --"
            isClearable
          />

          <label>Or Type Custom Industry</label>
          <input 
            type="text" 
            placeholder="e.g. Solar Panel Installers" 
            value={customIndustry}
            onChange={(e) => { setCustomIndustry(e.target.value); setIndustry(''); }}
          />

          <div style={{ display: 'flex', gap: '8px', marginTop: '24px' }}>
            <button 
              style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}
              onClick={() => startSearch(false)}
              disabled={isScraping || !selectedCountry || (!industry && !customIndustry)}
            >
              {isScraping ? <Activity className="animate-pulse" /> : <Search />}
              {isScraping ? 'Scraping...' : 'Start Search'}
            </button>

            {isScraping && (
              <button 
                style={{ flex: '0 0 auto', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', display: 'flex', gap: '8px', alignItems: 'center' }}
                onClick={cancelSearch}
              >
                <XCircle size={16} /> Cancel
              </button>
            )}
          </div>
          
          {statusMsg && (
            <div style={{ marginTop: '16px', padding: '12px', background: 'rgba(212, 175, 55, 0.1)', borderRadius: '4px', border: '1px solid rgba(212, 175, 55, 0.3)' }}>
              <small style={{ color: '#e2e8f0' }}>{statusMsg}</small>
            </div>
          )}
        </div>

        {/* Results Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h2 style={{ margin: 0 }}>Leads Found ({leads.length})</h2>
              {skippedCount > 0 && <p style={{ margin: '4px 0 0 0', fontSize: '0.85em', color: '#f59e0b' }}>Skipped {skippedCount} companies missing mandatory Email/Phone</p>}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button 
                onClick={() => startSearch(true)}
                disabled={isScraping}
                style={{ display: 'flex', gap: '8px', alignItems: 'center', background: 'transparent', border: '1px solid #d4af37', color: '#d4af37', boxShadow: 'none' }}
              >
                <Search size={16} /> Scrape More
              </button>
              <button 
                onClick={exportToCSV}
                disabled={leads.length === 0}
                style={{ display: 'flex', gap: '8px', alignItems: 'center', background: 'transparent', border: '1px solid #94a3b8', color: '#e2e8f0', boxShadow: 'none', cursor: leads.length === 0 ? 'not-allowed' : 'pointer', opacity: leads.length === 0 ? 0.6 : 1 }}
              >
                <Download size={16} /> Export CSV
              </button>
            </div>
          </div>

          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '650px', marginTop: '16px', flex: 1 }}>
            <table>
              <thead>
                <tr>
                  <th>Company Name</th>
                  <th>Customer Segment</th>
                  <th>Rating</th>
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
                    <td colSpan="10" style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
                      {isScraping ? 'Searching the web for matches...' : 'No leads generated yet. Start a search!'}
                    </td>
                  </tr>
                ) : (
                  leads.map((lead, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600, color: '#ffffff' }}>{lead.companyName}</td>
                      <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lead.industry}>
                        {lead.industry || '-'}
                      </td>
                      <td style={{ color: '#d4af37', fontWeight: 500 }}>{lead.rating || '-'}</td>
                      <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lead.address}>
                        {lead.address || '-'}
                      </td>
                      <td style={{ maxWidth: '250px', whiteSpace: 'pre-wrap', fontSize: '0.85em' }}>
                        {lead.contactPerson || '-'}
                      </td>
                      <td>{lead.mobileNumber || '-'}</td>
                      <td>{lead.landlineNumber || '-'}</td>
                      <td>
                        {lead.emailId ? <a href={`mailto:${lead.emailId.split(',')[0]}`} style={{ color: '#d4af37' }}>{lead.emailId}</a> : '-'}
                      </td>
                      <td>
                        {lead.website ? (
                          <a href={lead.website} target="_blank" rel="noreferrer" style={{ color: '#d4af37' }}>Link</a>
                        ) : '-'}
                      </td>
                      <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {lead.socials ? lead.socials.split(', ').map(link => (
                           <a key={link} href={link} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginRight: '8px', color: '#d4af37' }}>
                             {link.includes('linkedin') ? 'in' : link.includes('facebook') ? 'fb' : link.includes('twitter') ? 'tw' : link.includes('instagram') ? 'ig' : 'link'}
                           </a>
                        )) : '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
