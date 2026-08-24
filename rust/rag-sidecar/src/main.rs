use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, QueryParser, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TantivyDocument, Value, STORED, STRING, TEXT,
};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};

const MAX_DOCUMENTS: usize = 200_000;
const VERSION: &str = "0.1.0";

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Ping,
    Replace {
        revision: String,
        documents: Vec<InputDocument>,
    },
    Search {
        revision: String,
        query: String,
        limit: usize,
        owner_user_id: String,
        source_types: Vec<String>,
        scope_type: Option<String>,
        scope_id: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
struct InputDocument {
    id: String,
    text: String,
    owner_user_id: String,
    source_type: String,
    scope_type: String,
    scope_id: String,
    document_version: String,
}

#[derive(Debug, Serialize)]
struct ResultItem {
    id: String,
    score: f32,
    source_type: String,
    document_version: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Response {
    Ok {
        revision: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        results: Option<Vec<ResultItem>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        document_count: Option<usize>,
    },
    Error {
        code: String,
        message: String,
    },
}

struct Fields {
    id: Field,
    text: Field,
    owner: Field,
    source_type: Field,
    scope_type: Field,
    scope_id: Field,
    version: Field,
}

struct State {
    index: Index,
    reader: IndexReader,
    fields: Fields,
    revision: String,
    document_count: usize,
    revision_path: Option<PathBuf>,
}

fn create_schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let id = builder.add_text_field("id", STRING | STORED);
    let text = builder.add_text_field("text", TEXT);
    let owner = builder.add_text_field("owner_user_id", STRING);
    let source_type = builder.add_text_field("source_type", STRING | STORED);
    let scope_type = builder.add_text_field("scope_type", STRING);
    let scope_id = builder.add_text_field("scope_id", STRING);
    let version = builder.add_text_field("document_version", STRING | STORED);
    let schema = builder.build();
    let fields = Fields {
        id,
        text,
        owner,
        source_type,
        scope_type,
        scope_id,
        version,
    };
    (schema, fields)
}

fn create_state(index_dir: Option<&str>) -> tantivy::Result<State> {
    let (schema, fields) = create_schema();
    let revision_path = index_dir.map(|dir| PathBuf::from(dir).join("sidecar.revision"));
    let index = if let Some(index_dir) = index_dir {
        std::fs::create_dir_all(index_dir)
            .map_err(|error| tantivy::TantivyError::IoError(error.into()))?;
        match Index::open_in_dir(index_dir) {
            Ok(index) => index,
            Err(_) => Index::create_in_dir(index_dir, schema)?,
        }
    } else {
        Index::create_in_ram(schema)
    };
    let reader = index
        .reader_builder()
        .reload_policy(ReloadPolicy::Manual)
        .try_into()?;
    let revision = revision_path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    let document_count = reader.searcher().num_docs() as usize;
    Ok(State {
        index,
        reader,
        fields,
        revision,
        document_count,
        revision_path,
    })
}

fn exact_filter(field: Field, value: &str) -> Box<dyn tantivy::query::Query> {
    Box::new(TermQuery::new(
        Term::from_field_text(field, value),
        IndexRecordOption::Basic,
    ))
}

fn replace(state: &mut State, revision: String, documents: Vec<InputDocument>) -> Response {
    if documents.len() > MAX_DOCUMENTS {
        return Response::Error {
            code: "document_limit_exceeded".into(),
            message: format!("文档数量超过限制 {}", MAX_DOCUMENTS),
        };
    }
    let mut writer: IndexWriter = match state.index.writer(64_000_000) {
        Ok(writer) => writer,
        Err(error) => {
            return Response::Error {
                code: "writer_unavailable".into(),
                message: error.to_string(),
            }
        }
    };
    if let Err(error) = writer.delete_all_documents() {
        return Response::Error {
            code: "delete_failed".into(),
            message: error.to_string(),
        };
    }
    for document in &documents {
        if let Err(error) = writer.add_document(doc!(
            state.fields.id => document.id.clone(),
            state.fields.text => document.text.clone(),
            state.fields.owner => document.owner_user_id.clone(),
            state.fields.source_type => document.source_type.clone(),
            state.fields.scope_type => document.scope_type.clone(),
            state.fields.scope_id => document.scope_id.clone(),
            state.fields.version => document.document_version.clone(),
        )) {
            return Response::Error {
                code: "document_failed".into(),
                message: error.to_string(),
            };
        }
    }
    if let Err(error) = writer.commit() {
        return Response::Error {
            code: "commit_failed".into(),
            message: error.to_string(),
        };
    }
    if let Err(error) = state.reader.reload() {
        return Response::Error {
            code: "reload_failed".into(),
            message: error.to_string(),
        };
    }
    if let Some(path) = &state.revision_path {
        let temporary = path.with_extension("revision.tmp");
        if let Err(error) =
            std::fs::write(&temporary, &revision).and_then(|_| std::fs::rename(&temporary, path))
        {
            return Response::Error {
                code: "revision_persist_failed".into(),
                message: error.to_string(),
            };
        }
    }
    state.revision = revision.clone();
    state.document_count = documents.len();
    Response::Ok {
        revision,
        results: None,
        document_count: Some(documents.len()),
    }
}

fn search(
    state: &State,
    revision: String,
    query: String,
    limit: usize,
    owner_user_id: String,
    source_types: Vec<String>,
    scope_type: Option<String>,
    scope_id: Option<String>,
) -> Response {
    if revision != state.revision {
        return Response::Error {
            code: "revision_mismatch".into(),
            message: "sidecar revision 与请求不一致".into(),
        };
    }
    let limit = limit.clamp(1, 50);
    let searcher = state.reader.searcher();
    let parser = QueryParser::for_index(&state.index, vec![state.fields.text]);
    let text_query = match parser.parse_query(&query) {
        Ok(query) => query,
        Err(error) => {
            return Response::Error {
                code: "invalid_query".into(),
                message: error.to_string(),
            }
        }
    };
    let mut clauses: Vec<(Occur, Box<dyn tantivy::query::Query>)> = vec![
        (Occur::Must, text_query),
        (
            Occur::Must,
            exact_filter(state.fields.owner, &owner_user_id),
        ),
    ];
    if !source_types.is_empty() {
        let source_queries = source_types
            .into_iter()
            .map(|source| {
                (
                    Occur::Should,
                    exact_filter(state.fields.source_type, &source),
                )
            })
            .collect();
        clauses.push((Occur::Must, Box::new(BooleanQuery::new(source_queries))));
    }
    if let Some(scope_type) = scope_type {
        clauses.push((
            Occur::Must,
            exact_filter(state.fields.scope_type, &scope_type),
        ));
    }
    if let Some(scope_id) = scope_id {
        clauses.push((Occur::Must, exact_filter(state.fields.scope_id, &scope_id)));
    }
    let query = BooleanQuery::new(clauses);
    let top_docs = match searcher.search(&query, &TopDocs::with_limit(limit)) {
        Ok(results) => results,
        Err(error) => {
            return Response::Error {
                code: "search_failed".into(),
                message: error.to_string(),
            }
        }
    };
    let mut results = Vec::with_capacity(top_docs.len());
    for (score, address) in top_docs {
        let Ok(document) = searcher.doc::<TantivyDocument>(address) else {
            continue;
        };
        let Some(id) = document
            .get_first(state.fields.id)
            .and_then(|value| value.as_str())
        else {
            continue;
        };
        let Some(source_type) = document
            .get_first(state.fields.source_type)
            .and_then(|value| value.as_str())
        else {
            continue;
        };
        let version = document
            .get_first(state.fields.version)
            .and_then(|value| value.as_str())
            .unwrap_or("");
        results.push(ResultItem {
            id: id.into(),
            score,
            source_type: source_type.into(),
            document_version: version.into(),
        });
    }
    Response::Ok {
        revision,
        results: Some(results),
        document_count: None,
    }
}

fn handle(state: &mut State, request: Request) -> Response {
    match request {
        Request::Ping => Response::Ok {
            revision: state.revision.clone(),
            results: None,
            document_count: Some(state.document_count),
        },
        Request::Replace {
            revision,
            documents,
        } => replace(state, revision, documents),
        Request::Search {
            revision,
            query,
            limit,
            owner_user_id,
            source_types,
            scope_type,
            scope_id,
        } => search(
            state,
            revision,
            query,
            limit,
            owner_user_id,
            source_types,
            scope_type,
            scope_id,
        ),
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    if matches!(args.next().as_deref(), Some("--version")) {
        println!("gugu-rag-sidecar {VERSION}");
        return;
    }
    let index_dir = args.next();
    let mut state = create_state(index_dir.as_deref()).expect("初始化 Tantivy 失败");
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<Request>(&line) {
                Ok(request) => handle(&mut state, request),
                Err(error) => Response::Error {
                    code: "invalid_request".into(),
                    message: error.to_string(),
                },
            },
            Err(error) => Response::Error {
                code: "stdin_failed".into(),
                message: error.to_string(),
            },
        };
        serde_json::to_writer(&mut stdout, &response).expect("写入响应失败");
        stdout.write_all(b"\n").expect("写入换行失败");
        stdout.flush().expect("刷新响应失败");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_then_search_respects_revision_and_owner() {
        let mut state = create_state(None).unwrap();
        let response = replace(
            &mut state,
            "r1".into(),
            vec![
                InputDocument {
                    id: "a".into(),
                    text: "项目 计划".into(),
                    owner_user_id: "u1".into(),
                    source_type: "project".into(),
                    scope_type: "owner".into(),
                    scope_id: "".into(),
                    document_version: "v1".into(),
                },
                InputDocument {
                    id: "b".into(),
                    text: "项目 资料".into(),
                    owner_user_id: "u2".into(),
                    source_type: "project".into(),
                    scope_type: "owner".into(),
                    scope_id: "".into(),
                    document_version: "v1".into(),
                },
            ],
        );
        assert!(matches!(response, Response::Ok { .. }));
        let response = search(
            &state,
            "r1".into(),
            "项目".into(),
            10,
            "u1".into(),
            vec!["project".into()],
            None,
            None,
        );
        match response {
            Response::Ok {
                results: Some(results),
                ..
            } => assert_eq!(results[0].id, "a"),
            _ => panic!("查询失败"),
        }
        assert!(
            matches!(search(&state, "r2".into(), "项目".into(), 10, "u1".into(), vec![], None, None), Response::Error { code, .. } if code == "revision_mismatch")
        );
    }

    #[test]
    fn search_applies_scope_and_empty_replace() {
        let mut state = create_state(None).unwrap();
        replace(
            &mut state,
            "r1".into(),
            vec![
                InputDocument {
                    id: "group-a".into(),
                    text: "项目 计划".into(),
                    owner_user_id: "u1".into(),
                    source_type: "project".into(),
                    scope_type: "group".into(),
                    scope_id: "g1".into(),
                    document_version: "v1".into(),
                },
                InputDocument {
                    id: "group-b".into(),
                    text: "项目 资料".into(),
                    owner_user_id: "u1".into(),
                    source_type: "project".into(),
                    scope_type: "group".into(),
                    scope_id: "g2".into(),
                    document_version: "v1".into(),
                },
            ],
        );
        match search(
            &state,
            "r1".into(),
            "项目".into(),
            10,
            "u1".into(),
            vec!["project".into()],
            Some("group".into()),
            Some("g1".into()),
        ) {
            Response::Ok {
                results: Some(results),
                ..
            } => assert_eq!(
                results
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                vec!["group-a"]
            ),
            _ => panic!("scope 查询失败"),
        }
        assert!(matches!(
            replace(&mut state, "r2".into(), vec![]),
            Response::Ok {
                document_count: Some(0),
                ..
            }
        ));
        match search(
            &state,
            "r2".into(),
            "项目".into(),
            10,
            "u1".into(),
            vec![],
            None,
            None,
        ) {
            Response::Ok {
                results: Some(results),
                ..
            } => assert!(results.is_empty()),
            _ => panic!("空索引查询失败"),
        }
    }

    #[test]
    fn persistent_index_reopens_with_revision() {
        let path = std::env::temp_dir().join(format!(
            "gugu-rag-sidecar-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut state = create_state(path.to_str()).unwrap();
            assert!(matches!(
                replace(
                    &mut state,
                    "persisted".into(),
                    vec![InputDocument {
                        id: "persisted-id".into(),
                        text: "持久化 检索".into(),
                        owner_user_id: "u1".into(),
                        source_type: "note".into(),
                        scope_type: "owner".into(),
                        scope_id: "".into(),
                        document_version: "v1".into(),
                    }]
                ),
                Response::Ok { .. }
            ));
        }
        let state = create_state(path.to_str()).unwrap();
        assert_eq!(state.revision, "persisted");
        match search(
            &state,
            "persisted".into(),
            "持久化".into(),
            10,
            "u1".into(),
            vec!["note".into()],
            None,
            None,
        ) {
            Response::Ok {
                results: Some(results),
                ..
            } => assert_eq!(results[0].id, "persisted-id"),
            _ => panic!("持久化索引重启查询失败"),
        }
        let _ = std::fs::remove_dir_all(path);
    }
}
