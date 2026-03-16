import React, { useEffect, useState } from "react";
import axios from "axios";
import { Line, Bar, Pie } from "react-chartjs-2";
import "chart.js/auto";

const API_BASE = "/api/analytics";

export default function AnalyticsDashboard() {
  const [tvlHistory, setTvlHistory] = useState([]);
  const [utilizationCurves, setUtilizationCurves] = useState([]);
  const [revenueBreakdown, setRevenueBreakdown] = useState([]);
  const [cohorts, setCohorts] = useState([]);

  useEffect(() => {
    axios.get(`${API_BASE}/tvl-history`).then(res => setTvlHistory(res.data.tvlHistory));
    axios.get(`${API_BASE}/utilization-curves`).then(res => setUtilizationCurves(res.data.utilizationCurves));
    axios.get(`${API_BASE}/revenue-breakdown`).then(res => setRevenueBreakdown(res.data.revenueBreakdown));
    axios.get(`${API_BASE}/user-cohorts`).then(res => setCohorts(res.data.cohorts));
  }, []);

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6">Protocol Analytics Dashboard</h1>
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">TVL History</h2>
        <Line data={{
          labels: tvlHistory.map(d => d.date),
          datasets: [{
            label: "TVL",
            data: tvlHistory.map(d => d.value),
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59,130,246,0.2)",
          }],
        }} />
      </section>
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">Utilization Curves</h2>
        <Bar data={{
          labels: utilizationCurves.map(d => d.date),
          datasets: [{
            label: "Utilization",
            data: utilizationCurves.map(d => d.value),
            backgroundColor: "#10b981",
          }],
        }} />
      </section>
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">Revenue Breakdown</h2>
        <Pie data={{
          labels: revenueBreakdown.map(d => d.category),
          datasets: [{
            label: "Revenue",
            data: revenueBreakdown.map(d => d.amount),
            backgroundColor: ["#f59e42", "#6366f1", "#ef4444", "#22d3ee"],
          }],
        }} />
      </section>
      <section>
        <h2 className="text-xl font-semibold mb-2">User Cohorts</h2>
        <table className="min-w-full border">
          <thead>
            <tr>
              <th className="border px-4 py-2">Cohort</th>
              <th className="border px-4 py-2">Retention</th>
              <th className="border px-4 py-2">Avg Position Size</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c, i) => (
              <tr key={i}>
                <td className="border px-4 py-2">{c.name}</td>
                <td className="border px-4 py-2">{c.retention}</td>
                <td className="border px-4 py-2">{c.avgPositionSize}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
