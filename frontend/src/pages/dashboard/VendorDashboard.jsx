import { useAuth } from '../../context/AuthContext';

export default function VendorDashboard() {
  const { user, role, signOut } = useAuth();

  return (
    <div className="max-w-3xl mx-auto mt-16 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Vendor Dashboard</h1>
        <button onClick={signOut} className="text-sm text-red-600 underline">Sign out</button>
      </div>
      <p className="mt-4 text-gray-600">
        Signed in as {user?.email} — role: <span className="font-mono">{role}</span>
      </p>
      {/* TODO: wallet balance + ledger, generate PDF on behalf of customer, payout request */}
    </div>
  );
}
