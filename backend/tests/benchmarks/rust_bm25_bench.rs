//! 独立 Rust BM25 基准：读取 Python 侧预分词后的 TSV，比较倒排查询核心。
use std::collections::HashMap;
use std::fs;
use std::time::Instant;

struct Doc { len: usize }

struct Index {
    docs: Vec<Doc>,
    postings: HashMap<String, Vec<(usize, u32)>>,
    avg_len: f64,
    k1: f64,
    b: f64,
}

fn build(path: &str) -> Index {
    let text = fs::read_to_string(path).expect("读取语料失败");
    let mut docs = Vec::new();
    let mut postings: HashMap<String, Vec<(usize, u32)>> = HashMap::new();
    let mut total_len = 0usize;

    for line in text.lines() {
        let terms_part = line.split_once('\t').map(|(_, value)| value).unwrap_or("");
        let mut terms = HashMap::new();
        for term in terms_part.split_whitespace() {
            *terms.entry(term.to_string()).or_insert(0) += 1;
        }
        let len = terms.values().sum::<u32>() as usize;
        total_len += len;
        let doc_id = docs.len();
        for (term, frequency) in &terms {
            postings.entry(term.clone()).or_default().push((doc_id, *frequency));
        }
        docs.push(Doc { len });
    }

    let avg_len = if docs.is_empty() { 0.0 } else { total_len as f64 / docs.len() as f64 };
    Index { docs, postings, avg_len, k1: 1.2, b: 0.75 }
}

fn search(index: &Index, query: &str, limit: usize) -> Vec<(usize, f64)> {
    let mut scores: HashMap<usize, f64> = HashMap::new();
    let mut seen: HashMap<&str, bool> = HashMap::new();

    for term in query.split_whitespace() {
        if seen.insert(term, true).is_some() { continue; }
        let Some(posting) = index.postings.get(term) else { continue; };
        let document_frequency = posting.len() as f64;
        let total = index.docs.len() as f64;
        let idf = (1.0 + (total - document_frequency + 0.5) / (document_frequency + 0.5)).ln();
        for &(doc_id, frequency) in posting {
            let length = index.docs[doc_id].len.max(1) as f64;
            let norm = frequency as f64
                + index.k1 * (1.0 - index.b + index.b * length / index.avg_len.max(1.0));
            let score = idf * frequency as f64 * (index.k1 + 1.0) / norm;
            *scores.entry(doc_id).or_insert(0.0) += score;
        }
    }

    let mut ranked: Vec<(usize, f64)> = scores.into_iter().collect();
    ranked.sort_by(|left, right| {
        right.1.partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.0.cmp(&right.0))
    });
    ranked.truncate(limit);
    ranked
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|left, right| left.partial_cmp(right).unwrap());
    values[values.len() / 2]
}

fn percentile(values: &mut [f64], percentile: f64) -> f64 {
    values.sort_by(|left, right| left.partial_cmp(right).unwrap());
    values[((values.len() as f64 - 1.0) * percentile).round() as usize]
}

fn main() {
    let corpus = std::env::args().nth(1).expect("缺少语料路径");
    let query_path = std::env::args().nth(2).expect("缺少查询路径");
    let query_text = fs::read_to_string(query_path).expect("读取查询失败");
    let queries: Vec<&str> = query_text.lines().filter(|line| !line.is_empty()).collect();

    let mut cold = Vec::new();
    let mut document_count = 0;
    for _ in 0..10 {
        let started = Instant::now();
        let index = build(&corpus);
        document_count = index.docs.len();
        cold.push(started.elapsed().as_secs_f64() * 1000.0);
    }

    let index = build(&corpus);
    let mut warm = Vec::new();
    let mut checksum = 0usize;
    for _ in 0..20 {
        let started = Instant::now();
        for query in &queries { checksum += search(&index, query, 10).len(); }
        warm.push(started.elapsed().as_secs_f64() * 1000.0 / queries.len() as f64);
    }

    let mut cold_sorted = cold.clone();
    let mut warm_sorted = warm.clone();
    println!("rust_docs={document_count}");
    println!("rust_cold_mean_ms={:.4}", cold.iter().sum::<f64>() / cold.len() as f64);
    println!("rust_cold_p50_ms={:.4}", median(&mut cold_sorted));
    println!("rust_cold_p95_ms={:.4}", percentile(&mut cold_sorted, 0.95));
    println!("rust_warm_query_mean_ms={:.4}", warm.iter().sum::<f64>() / warm.len() as f64);
    println!("rust_warm_query_p50_ms={:.4}", median(&mut warm_sorted));
    println!("rust_warm_query_p95_ms={:.4}", percentile(&mut warm_sorted, 0.95));
    println!("rust_mean_result_count={:.2}", checksum as f64 / (20 * queries.len()) as f64);
    println!("rust_checksum={checksum}");
}
