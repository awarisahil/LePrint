import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function AuthPage() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [accountType, setAccountType] = useState('CUSTOMER'); // 'CUSTOMER' or 'VENDOR'
  const [businessName, setBusinessName] = useState('');
  const [error, setError] = useState('');
  const { user, signUp, signIn } = useAuth();

  if (user) return <Navigate to="/" replace />;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (isSignUp) {
        await signUp(email, password, fullName, accountType, businessName);
        alert('Account created! You can log in now.');
        setIsSignUp(false);
      } else {
        await signIn(email, password);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-20 p-6 bg-white rounded-lg shadow border">
      <h2 className="text-2xl font-bold mb-4">{isSignUp ? 'Create Account' : 'Login'}</h2>
      {error && <p className="text-red-500 mb-3 text-sm">{error}</p>}

      <form onSubmit={handleSubmit} className="space-y-4">
        {isSignUp && (
          <>
            <div>
              <label className="block text-sm font-medium">Full Name</label>
              <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} required className="w-full p-2 border rounded" />
            </div>
            <div>
              <label className="block text-sm font-medium">Account Type</label>
              <select value={accountType} onChange={e => setAccountType(e.target.value)} className="w-full p-2 border rounded">
                <option value="CUSTOMER">Customer (Direct Generation)</option>
                <option value="VENDOR">Vendor (Generates for others)</option>
              </select>
            </div>
            {accountType === 'VENDOR' && (
              <div>
                <label className="block text-sm font-medium">Business Name</label>
                <input type="text" value={businessName} onChange={e => setBusinessName(e.target.value)} required className="w-full p-2 border rounded" />
              </div>
            )}
          </>
        )}
        <div>
          <label className="block text-sm font-medium">Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="w-full p-2 border rounded" />
        </div>
        <div>
          <label className="block text-sm font-medium">Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required className="w-full p-2 border rounded" />
        </div>
        <button type="submit" className="w-full bg-blue-600 text-white p-2 rounded font-semibold">
          {isSignUp ? 'Sign Up' : 'Login'}
        </button>
      </form>
      <button onClick={() => setIsSignUp(!isSignUp)} className="mt-4 text-sm text-blue-600 underline w-full text-center">
        {isSignUp ? 'Already have an account? Login' : "Don't have an account? Sign Up"}
      </button>
    </div>
  );
}
