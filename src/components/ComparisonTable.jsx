import React from 'react';

export function ComparisonTable({ columns = [], rows = [], caption }) {
  return (
    <div className="comparison-table-wrap">
      <table className="comparison-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => <th key={column.key || column}>{column.label || column}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id || index}>
              {columns.map((column) => <td key={column.key || column}>{row[column.key || column]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
